import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcExtensionUIRequest } from '@earendil-works/pi-coding-agent'
import type { PiExtensionDialogRequest, PiExtensionEvent, PiExtensionUIResponse } from '@pi-meme/contracts/pi'
import type { ExtensionBridge } from '@pi-meme/contracts/desktop'

export type ExtensionNotice = {
  id: number
  message: string
  type: NonNullable<Extract<RpcExtensionUIRequest, { method: 'notify' }>['notifyType']>
}
export type ExtensionWidget = {
  key: string
  lines: string[]
  placement: NonNullable<Extract<RpcExtensionUIRequest, { method: 'setWidget' }>['widgetPlacement']>
}

export function useExtensionUI(
  bridge: Pick<ExtensionBridge, 'respondExtensionUI'>,
  setDraft: (value: string) => void,
  currentSessionKey: () => string | undefined,
) {
  const [extensionDialogs, setExtensionDialogs] = useState<PiExtensionDialogRequest[]>([])
  const [extensionStatuses, setExtensionStatuses] = useState<Record<string, string>>({})
  const [extensionWidgets, setExtensionWidgets] = useState<Record<string, ExtensionWidget>>({})
  const [extensionNotices, setExtensionNotices] = useState<ExtensionNotice[]>([])
  const [extensionTitle, setExtensionTitle] = useState('')

  const [draftFocusVersion, setDraftFocusVersion] = useState(0)
  const resetVersion = useRef(0)
  const noticeId = useRef(0)
  const noticeTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const sessionKeyRef = useRef(currentSessionKey)
  sessionKeyRef.current = currentSessionKey
  const bridgeRef = useRef(bridge)
  bridgeRef.current = bridge
  const reset = useCallback(() => {
    resetVersion.current += 1
    setExtensionDialogs([])
    setExtensionStatuses({})
    setExtensionWidgets({})
    setExtensionNotices([])
    setExtensionTitle('')
    for (const timer of noticeTimers.current.values()) clearTimeout(timer)
    noticeTimers.current.clear()
  }, [])
  const showNotice = (message: string, type: ExtensionNotice['type']) => {
    const id = ++noticeId.current
    setExtensionNotices((value) => [...value, { id, message, type }])
    noticeTimers.current.set(
      id,
      setTimeout(() => {
        setExtensionNotices((value) => value.filter((notice) => notice.id !== id))
        noticeTimers.current.delete(id)
      }, 5000),
    )
  }
  const handleEvent = useCallback(
    (event: PiExtensionEvent) => {
      if (event.type === 'extension_ui_timeout' || event.type === 'extension_ui_closed') {
        setExtensionDialogs((value) => value.filter((request) => request.id !== event.id))
        return
      }
      if (
        event.method === 'select' ||
        event.method === 'confirm' ||
        event.method === 'input' ||
        event.method === 'editor'
      ) {
        setExtensionDialogs((value) => [...value.filter((request) => request.id !== event.id), event])
      } else if (event.method === 'notify') {
        showNotice(event.message, event.notifyType ?? 'info')
      } else if (event.method === 'setStatus') {
        setExtensionStatuses((value) => {
          const next = { ...value }
          if (event.statusText === undefined) delete next[event.statusKey]
          else next[event.statusKey] = event.statusText
          return next
        })
      } else if (event.method === 'setWidget') {
        setExtensionWidgets((value) => {
          const next = { ...value }
          if (!event.widgetLines?.length) delete next[event.widgetKey]
          else
            next[event.widgetKey] = {
              key: event.widgetKey,
              lines: event.widgetLines,
              placement: event.widgetPlacement ?? 'aboveEditor',
            }
          return next
        })
      } else if (event.method === 'setTitle') {
        setExtensionTitle(event.title)
      } else if (event.method === 'set_editor_text') {
        setDraft(event.text)
        setDraftFocusVersion((value) => value + 1)
      }
    },
    [setDraft],
  )

  useEffect(() => () => reset(), [reset])

  return {
    extensionDialogs,
    extensionStatuses,
    extensionWidgets: Object.values(extensionWidgets),
    extensionNotices,
    extensionTitle,
    draftFocusVersion,
    focusDraft: () => setDraftFocusVersion((value) => value + 1),
    reset,
    handleEvent,
    dismissNotice: (id: number) => {
      const timer = noticeTimers.current.get(id)
      if (timer) clearTimeout(timer)
      noticeTimers.current.delete(id)
      setExtensionNotices((value) => value.filter((notice) => notice.id !== id))
    },
    answerExtensionDialog: async (id: string, response: PiExtensionUIResponse) => {
      const version = resetVersion.current
      const sessionKey = sessionKeyRef.current()
      if (!sessionKey) return
      await bridgeRef.current.respondExtensionUI(sessionKey, id, response)
      if (version !== resetVersion.current) return
      setExtensionDialogs((value) => value.filter((request) => request.id !== id))
    },
  }
}
