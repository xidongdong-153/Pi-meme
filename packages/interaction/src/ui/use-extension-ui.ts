import { InteractionQueue, type SourcedDialog, type InteractionSource } from './interaction-queue'
import type { PendingInteraction } from '@pi-meme/contracts/collaboration'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcExtensionUIRequest } from '@earendil-works/pi-coding-agent'
import type { PiExtensionEvent, PiExtensionUIResponse } from '@pi-meme/contracts/pi'
import type { ExtensionBridge } from '@pi-meme/contracts/desktop'
import type { UserInputDraft } from './user-input-panel'

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
  const queue = useRef(new InteractionQueue())
  const questionDrafts = useRef(new Map<string, UserInputDraft>())
  const [extensionDialogs, setExtensionDialogs] = useState<SourcedDialog[]>([])
  const [extensionStatuses, setExtensionStatuses] = useState<Record<string, string>>({})
  const [extensionWidgets, setExtensionWidgets] = useState<Record<string, ExtensionWidget>>({})
  const [extensionNotices, setExtensionNotices] = useState<ExtensionNotice[]>([])
  const [extensionTitle, setExtensionTitle] = useState('')

  const [draftFocusVersion, setDraftFocusVersion] = useState(0)
  const noticeId = useRef(0)
  const noticeTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const sessionKeyRef = useRef(currentSessionKey)
  sessionKeyRef.current = currentSessionKey
  const bridgeRef = useRef(bridge)
  bridgeRef.current = bridge
  const reset = useCallback(() => {
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
    (event: PiExtensionEvent, context?: InteractionSource) => {
      const sessionKey = context?.sessionKey ?? sessionKeyRef.current()
      if (!sessionKey) return
      const executionGeneration = context?.executionGeneration ?? 0
      const source = { sessionKey, executionGeneration, source: context?.source }
      if (event.type === 'extension_ui_timeout' || event.type === 'extension_ui_closed') {
        setExtensionDialogs(queue.current.receive(event, source))
        for (const id of questionDrafts.current.keys()) if (!queue.current.get(id)) questionDrafts.current.delete(id)
        return
      }
      if (
        event.method === 'select' ||
        event.method === 'confirm' ||
        event.method === 'input' ||
        event.method === 'editor' ||
        event.method === 'questions'
      ) {
        setExtensionDialogs(queue.current.receive(event, source))
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
    extensionDialogs: extensionDialogs.filter(
      (request) => (request.source?.rootSessionKey ?? request.sessionKey) === currentSessionKey(),
    ),
    restoreInteractions: (pending: PendingInteraction[]) => {
      const rootKey = sessionKeyRef.current()
      setExtensionDialogs(queue.current.restore(rootKey, pending))
      for (const id of questionDrafts.current.keys()) if (!queue.current.get(id)) questionDrafts.current.delete(id)
    },
    getQuestionDraft: (id: string) => questionDrafts.current.get(id),
    saveQuestionDraft: (id: string, draft: UserInputDraft) => {
      if (queue.current.get(id)) questionDrafts.current.set(id, draft)
    },
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
      const dialog = queue.current.get(id)
      if (!dialog) return
      await bridgeRef.current.respondExtensionUI(dialog.sessionKey, dialog.requestId, response)
      queue.current.remove(id)
      questionDrafts.current.delete(id)
      setExtensionDialogs(queue.current.all)
    },
  }
}
