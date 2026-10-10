import { queuedDraft } from './composer/restore-queued-input'
import { ChatStream } from './model/chat-stream'
import type { ChatState } from './model/types'
import { prepareComposerMessage, sendQueueMode } from './composer/plan-input'
import { SessionMode } from './composer/session-mode'
import { normalizePlanMessage, type TaskMode, type QueuedInput } from '@pi-meme/contracts/plan'
import { skillMarker, skillMessageParts } from '@pi-meme/contracts/skills'
import { useCallback, useRef, useState } from 'react'
import type { ChatBridge, DesktopEvent, Snapshot } from '@pi-meme/contracts/desktop'
import type { PiEvent, PiSlashCommand } from '@pi-meme/contracts/pi'
import { applyEvent as reduceEvent, emptyChat, restoreSnapshot } from './model/state'
import type { ComposerAttachment as Attachment } from './composer/image-attachment'

const emptySkills: PiSlashCommand[] = []

export type QueueMode = 'steering' | 'followUp'

export type ComposerSnapshot = {
  draft: string
  selectedSkills: PiSlashCommand[]
  attachments: Attachment[]
  queueMode: QueueMode
  recoveredInputs?: QueuedInput[]
  editing?: { timestamp: number; restore: Omit<ComposerSnapshot, 'editing'> }
}

export type ChatSessionOptions = {
  bridge: ChatBridge
  commands: PiSlashCommand[]
  /** 连接就绪且没有互斥操作时返回 true */
  canSend: () => boolean
  /** 会话切换进行中时返回 true */
  isSwitching: () => boolean
  /** 存在后台会话切换时先等待其结束 */
  awaitPendingSwitch: () => Promise<void>
  currentGeneration: () => number
  currentSessionKey: () => string | undefined
  onError: (message: string) => void
  /** 首次发送失败并回滚草稿后触发，由 desktop 重新读取快照 */
  onSendFailed?: (sessionKey: string | undefined, composer: ComposerSnapshot) => void
}

/**
 * 聊天数据、草稿、附件与发送行为。连接、快照与事件订阅由 desktop 协调。
 */
export function useChatSession(options: ChatSessionOptions) {
  const [chat, setRenderedChat] = useState(emptyChat)
  const [chatStream] = useState(() => new ChatStream(emptyChat))
  const setChat = useCallback(
    (value: ChatState | ((state: ChatState) => ChatState)) => {
      chatStream.update(value)
      setRenderedChat(chatStream.getSnapshot())
    },
    [chatStream],
  )
  const [draft, setDraft] = useState('')
  const [selectedSkills, setSelectedSkills] = useState<PiSlashCommand[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [mode, setMode] = useState<TaskMode>('default')
  const modeWrites = useRef<Promise<unknown>>(Promise.resolve())
  const modeRef = useRef<TaskMode>('default')
  const modes = useRef(new SessionMode())
  const activeMode = useRef<TaskMode | undefined>(undefined)
  const [recoveredInputs, setRecoveredInputs] = useState<QueuedInput[]>([])
  const [queueMode, setQueueMode] = useState<QueueMode>('steering')
  const [editingTimestamp, setEditingTimestamp] = useState<number | null>(null)
  const editRestore = useRef<ComposerSnapshot | null>(null)
  const promptPending = useRef(false)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const loadSnapshot = useCallback(
    (snapshot: Snapshot, buffered: DesktopEvent[] | null, readModeRevision = modes.current.revision) => {
      const next = restoreSnapshot(snapshot, buffered)
      setChat(next)
      activeMode.current = snapshot.state.activeMode
      const key = snapshot.connection.sessionKey
      const nextMode = modes.current.snapshot(key, snapshot.state.mode, readModeRevision)
      modeRef.current = nextMode
      setMode(nextMode)
      return next
    },
    [setChat],
  )

  const applyEvent = useCallback(
    (event: Parameters<typeof reduceEvent>[1]) => {
      chatStream.update((value) => reduceEvent(value, event))
      if (event.type !== 'message_update') setRenderedChat(chatStream.getSnapshot())
    },
    [chatStream],
  )

  const clearComposer = useCallback(() => {
    setDraft('')
    setSelectedSkills([])
    setAttachments([])
    setRecoveredInputs([])
    setEditingTimestamp(null)
    editRestore.current = null
  }, [])

  const reset = useCallback(() => {
    setChat(emptyChat)
    setDraft('')
    setSelectedSkills([])
    setAttachments([])
    promptPending.current = false
    setEditingTimestamp(null)
    editRestore.current = null
  }, [])

  const clearPromptPending = useCallback(() => {
    promptPending.current = false
  }, [])

  /**
   * 提交编辑后立即截断被编辑消息之后的展示内容。
   * 这些后续轮次属于旧分支，重新发送会生成新版本；真实结果以快照刷新为准。
   */
  const beginEditBranch = useCallback((timestamp: number) => {
    setChat((value) => {
      const index = value.messages.findIndex((message) => message.role === 'user' && message.timestamp === timestamp)
      return {
        ...value,
        messages: index === -1 ? value.messages : value.messages.slice(0, index),
        live: null,
        stream: emptyChat.stream,
        tools: {},
        steering: [],
        followUp: [],
        running: true,
      }
    })
  }, [])

  const changeMode = useCallback((next: TaskMode) => {
    const key = optionsRef.current.currentSessionKey()
    if (!key) return
    modeRef.current = next
    const revision = modes.current.change(key, next)
    setMode(next)
    modeWrites.current = modeWrites.current
      .catch(() => {})
      .then(() => optionsRef.current.bridge.setSessionMode(key, next))
      .catch((cause) => {
        if (key === optionsRef.current.currentSessionKey())
          optionsRef.current.onError(`无法保存计划模式：${String(cause)}`)
      })
      .finally(() => modes.current.settled(key, revision))
  }, [])

  const activatePlan = useCallback(
    (value: string) => {
      changeMode('plan')
      setDraft(normalizePlanMessage(value, 'plan').text)
    },
    [changeMode],
  )

  const send = useCallback(async () => {
    const { bridge, canSend, isSwitching, awaitPendingSwitch, currentGeneration, onError, onSendFailed } =
      optionsRef.current
    const selectedGeneration = currentGeneration()
    await awaitPendingSwitch()
    if (isSwitching() || selectedGeneration !== currentGeneration()) return
    const normalized = prepareComposerMessage(draft, modeRef.current)
    const messageMode = normalized.mode
    if (messageMode !== modeRef.current) changeMode(messageMode)
    if (normalized.commandOnly) {
      setDraft(normalized.text)
      return
    }
    const message = normalized.text.trim()
    const skills = draft.includes(skillMarker) ? selectedSkills.map(({ name }) => ({ name })) : []
    const images = attachments.map(({ type, data, mimeType }) => ({ type, data, mimeType }))
    if ((!message && !images.length) || !canSend()) return
    const sessionKey = optionsRef.current.currentSessionKey()
    if (!sessionKey) return

    if (editingTimestamp !== null) {
      const target = editingTimestamp
      const restore = editRestore.current
      const previousMessages = chat.messages
      onError('')
      setDraft('')
      setSelectedSkills([])
      setAttachments([])
      // 立即退出编辑态并截断旧分支展示，避免同时出现编辑操作和生成状态。
      setEditingTimestamp(null)
      editRestore.current = null
      promptPending.current = true
      beginEditBranch(target)
      try {
        await bridge.editAndPrompt(sessionKey, target, message, images, skills, { mode: messageMode })
        // 编辑期间可能已切换会话，只有仍停留在原会话时才恢复编辑前的草稿与附件。
        if (restore && sessionKey === optionsRef.current.currentSessionKey()) {
          setDraft(restore.draft)
          setSelectedSkills(restore.selectedSkills)
          setAttachments(restore.attachments)
          setQueueMode(restore.queueMode)
        }
      } catch (cause) {
        const sameSession = sessionKey === optionsRef.current.currentSessionKey()
        promptPending.current = false
        if (sameSession) {
          // 失败时回到编辑态并保留用户修改后的内容，可继续修改或重试。
          editRestore.current = restore
          setEditingTimestamp(target)
          setDraft(draft)
          setSelectedSkills(selectedSkills)
          setAttachments(attachments)
          setChat((value) => ({ ...value, messages: previousMessages, running: false }))
        }
        onSendFailed?.(sessionKey, { draft, selectedSkills, attachments, queueMode })
        if (sameSession) onError(String(cause))
      }
      return
    }

    const running = chat.running || promptPending.current
    const sendMode = sendQueueMode(running, queueMode, messageMode, activeMode.current)
    const generation = currentGeneration()
    onError('')
    setDraft('')
    setSelectedSkills([])
    setAttachments([])
    if (!running) {
      promptPending.current = true
      setChat((value) => ({ ...value, running: true }))
    }
    try {
      if (sendMode === 'steering') await bridge.steer(sessionKey, message, images, skills, { mode: messageMode })
      else if (sendMode === 'followUp')
        await bridge.followUp(sessionKey, message, images, skills, { mode: messageMode })
      else {
        activeMode.current = messageMode
        await bridge.prompt(sessionKey, message, images, skills, { mode: messageMode })
      }
    } catch (cause) {
      const sameSession = sessionKey
        ? sessionKey === optionsRef.current.currentSessionKey()
        : generation === currentGeneration()
      if (!running) onSendFailed?.(sessionKey, { draft, selectedSkills, attachments, queueMode })
      if (sameSession) {
        setDraft((value) => value || draft)
        setSelectedSkills((value) => (value.length ? value : selectedSkills))
        setAttachments((value) => (value.length ? value : attachments))
        if (!running) {
          promptPending.current = false
        }
        onError(String(cause))
      }
    }
  }, [chat.running, draft, selectedSkills, attachments, queueMode, editingTimestamp, beginEditBranch, changeMode])

  const editMessage = useCallback(
    (message: Extract<PiEvent, { type: 'message_end' }>['message']) => {
      if (message.role !== 'user' || typeof message.timestamp !== 'number' || chat.running) return
      const content = 'content' in message ? message.content : undefined
      const images: Attachment[] = Array.isArray(content)
        ? content.flatMap((part) =>
            part.type === 'image'
              ? [{ id: crypto.randomUUID(), type: 'image' as const, data: part.data, mimeType: part.mimeType }]
              : [],
          )
        : []
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('')
            : ''
      const restoredSkills: PiSlashCommand[] = []
      const restoredDraft = skillMessageParts(text)
        .map((part) => {
          if (part.type === 'text') return part.text
          const skill = optionsRef.current.commands.find(
            (entry) =>
              entry.source === 'skill' && entry.name === `skill:${part.name}` && entry.sourceInfo.path === part.path,
          )
          if (!skill) return `$${part.name}`
          restoredSkills.push(skill)
          return skillMarker
        })
        .join('')
      editRestore.current = { draft, selectedSkills, attachments, queueMode }
      setEditingTimestamp(message.timestamp)
      setDraft(restoredDraft)
      setSelectedSkills(restoredSkills)
      setAttachments(images)
    },
    [chat.running, draft, selectedSkills, attachments, queueMode],
  )

  const cancelEdit = useCallback(() => {
    const restore = editRestore.current
    editRestore.current = null
    setEditingTimestamp(null)
    if (!restore) return
    setDraft(restore.draft)
    setSelectedSkills(restore.selectedSkills)
    setAttachments(restore.attachments)
    setQueueMode(restore.queueMode)
  }, [])

  const stop = useCallback(async () => {
    const { bridge, onError } = optionsRef.current
    onError('')
    try {
      const key = optionsRef.current.currentSessionKey()
      if (key) await bridge.abort(key)
    } catch (cause) {
      onError(String(cause))
    }
  }, [])

  const clearQueue = useCallback(async () => {
    const { bridge } = optionsRef.current
    const key = optionsRef.current.currentSessionKey()
    const generation = optionsRef.current.currentGeneration()
    if (!key) return
    const queued = await bridge.clearQueue(key)
    if (key !== optionsRef.current.currentSessionKey() || generation !== optionsRef.current.currentGeneration()) return
    setChat((value) => ({ ...value, steering: [], followUp: [] }))
    const inputs = [...queued.steering, ...queued.followUp]
    if (!inputs.length) return
    setRecoveredInputs((value) => [...value, ...inputs])
  }, [])

  const restoreQueuedInput = (input: QueuedInput) => {
    if (draft.trim() || selectedSkills.length || attachments.length) {
      optionsRef.current.onError('请先发送或清空当前草稿，再恢复排队消息。')
      return
    }
    const restored = queuedDraft(input, optionsRef.current.commands)
    setDraft(restored.draft)
    setSelectedSkills(restored.selectedSkills)
    setAttachments(restored.attachments)
    changeMode(restored.mode)
    setRecoveredInputs((value) => value.filter((entry) => entry.id !== input.id))
  }

  return {
    chat,
    chatStream,
    captureChat: chatStream.getSnapshot,
    mode,
    changeMode,
    activatePlan,
    recoveredInputs,
    restoreQueuedInput,
    restoreChat: setChat,
    draft,
    setDraft,
    selectedSkills: draft.includes(skillMarker) ? selectedSkills : emptySkills,
    setSelectedSkills,
    attachments,
    setAttachments,
    queueMode,
    setQueueMode,
    promptPending,
    loadSnapshot,
    captureModeRevision: () => modes.current.revision,
    applyEvent,
    clearPromptPending,
    clearComposer,
    captureComposer: () => ({
      draft,
      selectedSkills,
      attachments,
      queueMode,
      recoveredInputs,
      editing:
        editingTimestamp !== null && editRestore.current
          ? { timestamp: editingTimestamp, restore: editRestore.current }
          : undefined,
    }),
    restoreComposer: (value: ComposerSnapshot) => {
      setDraft(value.draft)
      setSelectedSkills(value.selectedSkills)
      setAttachments(value.attachments)
      setQueueMode(value.queueMode)
      setRecoveredInputs(value.recoveredInputs ?? [])
      setEditingTimestamp(value.editing?.timestamp ?? null)
      editRestore.current = value.editing?.restore ?? null
    },
    reset,
    send,
    stop,
    clearQueue,
    editing: editingTimestamp !== null,
    editingTimestamp,
    editMessage,
    cancelEdit,
  }
}
