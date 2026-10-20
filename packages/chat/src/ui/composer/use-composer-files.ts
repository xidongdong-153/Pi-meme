import { useEffect, useReducer, useRef } from 'react'
import type { ChatBridge } from '@pi-meme/contracts/desktop'
import { fileToAttachment, type ComposerAttachment } from './image-attachment'

type ComposerFilesOptions = {
  contextKey: string
  sessionKey?: string
  disabled: boolean
  uploadAttachment: ChatBridge['uploadAttachment']
  onAdd: (attachments: ComposerAttachment[]) => void
  onError: (message: string) => void
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
    pending: 0,
    controllers: new Set<AbortController>(),
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
      pending: 0,
      controllers: new Set<AbortController>(),
    }
  }
  const currentContext = context.current

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      currentContext.revision++
      currentContext.pending = 0
      for (const controller of currentContext.controllers) controller.abort()
      currentContext.controllers.clear()
    }
  }, [currentContext])

  function cancel() {
    const current = context.current
    current.revision++
    current.pending = 0
    for (const controller of current.controllers) controller.abort()
    current.controllers.clear()
    refresh()
  }

  async function addFiles(files: File[]) {
    if (!mounted.current || context.current.disabled || !files.length) return
    const current = context.current
    const revision = current.revision
    const targetSession = current.sessionKey
    const controller = new AbortController()
    const isCurrent = () =>
      mounted.current &&
      context.current === current &&
      current.revision === revision &&
      !current.disabled &&
      !controller.signal.aborted
    const failures: string[] = []
    current.controllers.add(controller)
    current.pending += files.length
    refresh()
    try {
      optionsRef.current.onError('')
      for (const file of files) {
        if (!isCurrent()) return
        try {
          const attachment = await fileToAttachment(file, (input) => {
            if (!isCurrent()) throw new Error('附件上传已取消')
            if (!targetSession) throw new Error('请先连接会话再添加文件')
            return optionsRef.current.uploadAttachment(targetSession, input, controller.signal)
          })
          if (isCurrent()) optionsRef.current.onAdd([attachment])
        } catch (cause) {
          if (isCurrent()) {
            const message = cause instanceof Error ? cause.message : String(cause)
            failures.push(file.name && !message.includes(file.name) ? `${file.name}：${message}` : message)
          }
        } finally {
          if (isCurrent()) {
            current.pending--
            refresh()
          }
        }
      }
      if (isCurrent() && failures.length) optionsRef.current.onError(failures.join('\n'))
    } finally {
      current.controllers.delete(controller)
    }
  }

  return {
    addFiles,
    cancel,
    pending: context.current.pending,
    uploading: context.current.pending > 0,
    isUploading: () => context.current.pending > 0,
  }
}
