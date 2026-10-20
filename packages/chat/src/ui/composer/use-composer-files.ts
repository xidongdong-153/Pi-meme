import { useEffect, useReducer, useRef } from 'react'
import type { ChatBridge } from '@pi-meme/contracts/desktop'
import {
  filePreview,
  fileToAttachment,
  type ComposerAttachment,
  type ComposerPendingAttachment,
} from './image-attachment'

type ComposerFilesOptions = {
  contextKey: string
  sessionKey?: string
  disabled: boolean
  uploadAttachment: ChatBridge['uploadAttachment']
  onAdd: (attachments: ComposerAttachment[]) => void
  onError: (message: string) => void
}

type PendingUpload = {
  attachment: ComposerPendingAttachment
  controller: AbortController
}

export function useComposerFiles(options: ComposerFilesOptions) {
  const { contextKey, sessionKey, disabled } = options
  const optionsRef = useRef(options)
  optionsRef.current = options
  const mounted = useRef(true)
  const context = useRef({
    contextKey,
    sessionKey,
    disabled,
    revision: 0,
    uploads: new Map<string, PendingUpload>(),
  })
  const [, refresh] = useReducer((value: number) => value + 1, 0)
  if (
    context.current.contextKey !== contextKey ||
    context.current.sessionKey !== sessionKey ||
    context.current.disabled !== disabled
  ) {
    context.current = {
      contextKey,
      sessionKey,
      disabled,
      revision: context.current.revision + 1,
      uploads: new Map<string, PendingUpload>(),
    }
  }
  const currentContext = context.current

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      currentContext.revision++
      for (const { controller } of currentContext.uploads.values()) controller.abort()
      currentContext.uploads.clear()
    }
  }, [currentContext])

  function cancel() {
    const current = context.current
    current.revision++
    for (const { controller } of current.uploads.values()) controller.abort()
    current.uploads.clear()
    refresh()
  }

  function cancelUpload(id: string) {
    const current = context.current
    const upload = current.uploads.get(id)
    if (!upload) return
    current.uploads.delete(id)
    upload.controller.abort()
    refresh()
  }

  async function addFiles(files: File[]) {
    if (!mounted.current || context.current.disabled || !files.length) return
    const current = context.current
    const revision = current.revision
    const targetSession = current.sessionKey
    const isCurrent = () =>
      mounted.current && context.current === current && current.revision === revision && !current.disabled
    const failures: string[] = []
    const uploads = files.map((file) => {
      const attachment: ComposerPendingAttachment = {
        id: crypto.randomUUID(),
        type: 'file',
        name: file.name,
        preview: filePreview(file),
        progress: 0,
      }
      const upload = { attachment, controller: new AbortController() }
      current.uploads.set(attachment.id, upload)
      return { file, ...upload }
    })
    refresh()
    optionsRef.current.onError('')
    for (const { file, attachment, controller } of uploads) {
      if (!isCurrent()) return
      if (controller.signal.aborted) continue
      try {
        const completed = await fileToAttachment(
          file,
          (input) => {
            if (!isCurrent()) throw new Error('附件上传已取消')
            if (!targetSession) throw new Error('请先连接会话再添加文件')
            return optionsRef.current.uploadAttachment(targetSession, input, controller.signal, (progress) => {
              if (!isCurrent() || controller.signal.aborted) return
              const next = Math.max(0, Math.min(100, Math.round(progress)))
              if (!Number.isFinite(next) || attachment.progress === next) return
              attachment.progress = next
              refresh()
            })
          },
          attachment.id,
        )
        if (isCurrent() && !controller.signal.aborted) optionsRef.current.onAdd([completed])
      } catch (cause) {
        if (isCurrent() && !controller.signal.aborted) {
          const message = cause instanceof Error ? cause.message : String(cause)
          failures.push(file.name && !message.includes(file.name) ? `${file.name}：${message}` : message)
        }
      } finally {
        if (isCurrent()) {
          current.uploads.delete(attachment.id)
          refresh()
        }
      }
    }
    if (isCurrent() && failures.length) optionsRef.current.onError(failures.join('\n'))
  }

  return {
    addFiles,
    cancel,
    cancelUpload,
    uploads: Array.from(context.current.uploads.values(), ({ attachment }) => attachment),
    pending: context.current.uploads.size,
    uploading: context.current.uploads.size > 0,
    isUploading: () => context.current.uploads.size > 0,
  }
}
