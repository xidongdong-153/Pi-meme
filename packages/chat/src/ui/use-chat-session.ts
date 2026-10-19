import { parseGoalCommand, validateGoalInput, type GoalEdit } from '@pi-meme/contracts/goal'
import { visibleComposerHint } from './composer/composer-hint'
import { queuedDraft } from './composer/restore-queued-input'
import { ChatStream } from './model/chat-stream'
import { messageText } from './model/message-text'
import type { ChatState } from './model/types'
import { prepareComposerMessage } from './composer/plan-input'
import { SessionMode } from './composer/session-mode'
import { normalizePlanMessage, type TaskMode, type QueuedInput } from '@pi-meme/contracts/plan'
import { skillMarker, skillMessageParts } from '@pi-meme/contracts/skills'
import { useCallback, useRef, useState } from 'react'
import type { ChatBridge, DesktopEvent, Snapshot } from '@pi-meme/contracts/desktop'
import type { PiEvent, PiMessage, PiSlashCommand } from '@pi-meme/contracts/pi'
import { applyEvent as reduceEvent, emptyChat, restoreSnapshot } from './model/state'
import type { ComposerAttachment as Attachment } from './composer/image-attachment'

const emptySkills: PiSlashCommand[] = []

export type QueueMode = 'steering' | 'followUp'

export type ComposerSnapshot = {
  goalDraft?: true
  draft: string
  selectedSkills: PiSlashCommand[]
  pluginMentions?: string[]
  attachments: Attachment[]
  queueMode: QueueMode
  recoveredInputs?: QueuedInput[]
  editing?: { timestamp: number; restore: Omit<ComposerSnapshot, 'editing'> }
}

export type ChatSessionOptions = {
  bridge: ChatBridge
  commands: PiSlashCommand[]
  refresh?: () => Promise<void>
  /** 连接就绪且没有互斥操作时返回 true */
  canSend: () => boolean
  /** 会话切换进行中时返回 true */
  isSwitching: () => boolean
  /** 存在后台会话切换时先等待其结束 */
  awaitPendingSwitch: () => Promise<void>
  currentGeneration: () => number
  currentSessionKey: () => string | undefined
  onError: (message: string) => void
  /** 请求返回前保留待发送草稿；返回的函数在请求结束后释放保留记录。 */
  onSendStarted?: (sessionKey: string, composer: ComposerSnapshot) => () => void
  /** 发送失败并回滚草稿后触发，由 desktop 重新读取快照。 */
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
  const [goalDraft, setGoalDraft] = useState<ComposerSnapshot['goalDraft']>()
  const [goalOpen, setGoalOpen] = useState(false)
  const [goalEditing, setGoalEditing] = useState(false)
  const [dismissedHint, setDismissedHint] = useState<string | undefined>(undefined)
  const hintSession = useRef<string | undefined>(undefined)
  const composerHintRef = useRef<string | undefined>(undefined)
  const [selectedSkills, setSelectedSkills] = useState<PiSlashCommand[]>([])
  const [pluginMentions, setPluginMentions] = useState<string[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [mode, setMode] = useState<TaskMode>('default')
  const modeWrites = useRef<Promise<unknown>>(Promise.resolve())
  const modeRef = useRef<TaskMode>('default')
  const modes = useRef(new SessionMode())
  const activeMode = useRef<TaskMode | undefined>(undefined)
  const [recoveredInputs, setRecoveredInputs] = useState<QueuedInput[]>([])
  const [queueMode, setQueueMode] = useState<QueueMode>('followUp')
  const [editingTimestamp, setEditingTimestamp] = useState<number | null>(null)
  const editRestore = useRef<ComposerSnapshot | null>(null)
  const [editingQueue, setEditingQueue] = useState<string | null>(null)
  const queueEdit = useRef<{ id: string; key: string; restore: ComposerSnapshot; mode: TaskMode } | null>(null)
  const queueEditPending = useRef(false)
  const [savingQueue, setSavingQueue] = useState(false)
  const latestComposer = useRef<ComposerSnapshot>({ draft, selectedSkills, attachments, queueMode })
  latestComposer.current = {
    draft,
    goalDraft,
    selectedSkills,
    attachments,
    queueMode,
    ...(pluginMentions.length ? { pluginMentions } : {}),
  }
  const promptPending = useRef(false)
  const optionsRef = useRef(options)
  optionsRef.current = options
  composerHintRef.current = chat.composerHint

  const dismissComposerHint = useCallback(() => {
    if (composerHintRef.current) setDismissedHint(composerHintRef.current)
  }, [])

  const acceptComposerHint = useCallback(() => {
    const hint = composerHintRef.current
    if (!hint) return
    setDraft(hint)
  }, [])

  const loadSnapshot = useCallback(
    (snapshot: Snapshot, buffered: DesktopEvent[] | null, readModeRevision = modes.current.revision) => {
      const next = restoreSnapshot(snapshot, buffered)
      const key = snapshot.connection.sessionKey
      const previousKey = hintSession.current
      if (previousKey !== key) {
        hintSession.current = key
        setDismissedHint(undefined)
      }
      // 结算后的快照可能早于提示返回。同一会话的迟到快照不要把已经显示的提示清掉。
      const kept =
        !next.composerHint && previousKey === key && !next.running ? chatStream.getSnapshot().composerHint : undefined
      const merged = kept ? { ...next, composerHint: kept } : next
      setChat(merged)
      activeMode.current = snapshot.state.activeMode
      const nextMode = modes.current.snapshot(key, snapshot.state.mode, readModeRevision)
      modeRef.current = nextMode
      setMode(nextMode)
      return merged
    },
    [chatStream, setChat],
  )

  const applyEvent = useCallback(
    (event: Parameters<typeof reduceEvent>[1]) => {
      chatStream.update((value) => reduceEvent(value, event))
      if (event.type !== 'message_update') setRenderedChat(chatStream.getSnapshot())
    },
    [chatStream],
  )

  const releaseQueueEdit = useCallback(() => {
    const current = queueEdit.current
    queueEdit.current = null
    queueEditPending.current = false
    setEditingQueue(null)
    setSavingQueue(false)
    if (current)
      void optionsRef.current.bridge.cancelQueueEdit(current.key, current.id).catch((cause) => {
        if (current.key === optionsRef.current.currentSessionKey()) optionsRef.current.onError(String(cause))
      })
  }, [])

  const clearComposer = useCallback(() => {
    releaseQueueEdit()
    setGoalDraft(undefined)
    setGoalOpen(false)
    setGoalEditing(false)
    setDraft('')
    setSelectedSkills([])
    setPluginMentions([])
    setAttachments([])
    setRecoveredInputs([])
    setEditingTimestamp(null)
    editRestore.current = null
  }, [releaseQueueEdit])

  const reset = useCallback(() => {
    releaseQueueEdit()
    setChat(emptyChat)
    setDraft('')
    setSelectedSkills([])
    setPluginMentions([])
    setAttachments([])
    promptPending.current = false
    setEditingTimestamp(null)
    editRestore.current = null
  }, [releaseQueueEdit])

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

  const changeMode = useCallback(
    (next: TaskMode) => {
      const key = optionsRef.current.currentSessionKey()
      if (!key) return
      if (next === 'plan') setGoalDraft(undefined)
      modeRef.current = next
      const pausesGoal = next === 'plan' && chatStream.getSnapshot().goal?.status === 'active'
      const revision = modes.current.change(key, next)
      setMode(next)
      modeWrites.current = modeWrites.current
        .catch(() => {})
        .then(async () => {
          await optionsRef.current.bridge.setSessionMode(key, next)
          if (pausesGoal) {
            const cleared = await optionsRef.current.bridge.clearQueue(key)
            if (key === optionsRef.current.currentSessionKey())
              setRecoveredInputs((current) => [...current, ...cleared.steering, ...cleared.followUp])
          }
        })
        .catch((cause) => {
          if (key === optionsRef.current.currentSessionKey())
            optionsRef.current.onError(`无法保存计划模式：${String(cause)}`)
        })
        .finally(() => modes.current.settled(key, revision))
    },
    [chatStream],
  )

  const goalAction = useCallback(
    async (action: 'pause' | 'resume' | 'edit' | 'clear') => {
      const { bridge, currentSessionKey, currentGeneration } = optionsRef.current
      const key = currentSessionKey()
      const generation = currentGeneration()
      const goal = chatStream.getSnapshot().goal
      if (!key || !goal) throw new Error('当前会话没有目标')
      const owns = () => {
        if (key !== currentSessionKey()) return false
        if (action !== 'clear') return generation === currentGeneration()
        const currentGoal = chatStream.getSnapshot().goal
        return !currentGoal || currentGoal.goalId === goal.goalId
      }
      const method = action === 'edit' ? 'pauseGoal' : (`${action}Goal` as 'pauseGoal' | 'resumeGoal' | 'clearGoal')
      const operation = bridge[method]
      if (!operation) throw new Error('当前 Host 不支持目标')
      const next = await operation(key, goal)
      if (action === 'clear' && !owns()) return
      if (owns()) {
        setChat((state) => ({ ...state, goal: next || undefined }))
        setGoalEditing(action === 'edit')
        setGoalOpen(action !== 'clear')
      }
      if (action !== 'resume' && bridge.clearQueue) {
        const cleared = await bridge.clearQueue(key)
        if (owns()) setRecoveredInputs((current) => [...current, ...cleared.steering, ...cleared.followUp])
      }
      if (owns()) {
        await optionsRef.current.refresh?.()
      }
    },
    [chatStream, setChat],
  )

  const saveGoal = useCallback(
    async (input: GoalEdit) => {
      const { bridge, currentSessionKey, currentGeneration } = optionsRef.current
      const key = currentSessionKey()
      const generation = currentGeneration()
      if (!key || !bridge.editGoal) throw new Error('当前 Host 不支持目标')
      const goal = await bridge.editGoal(key, input)
      if (key === currentSessionKey() && generation === currentGeneration()) {
        setChat((state) => ({ ...state, goal }))
        setGoalEditing(false)
      }
    },
    [setChat],
  )

  const setMessageGoal = useCallback(
    async (message: PiMessage) => {
      const { bridge, currentSessionKey, currentGeneration, canSend, onError } = optionsRef.current
      const key = currentSessionKey()
      const generation = currentGeneration()
      if (!key || !canSend() || message.role !== 'user' || typeof message.timestamp !== 'number') return
      try {
        if (!bridge.startGoal) throw new Error('当前 Host 不支持目标')
        const objective = messageText(message)
        validateGoalInput({ objective })
        changeMode('default')
        await modeWrites.current
        const result = await bridge.startGoal(key, { objective, sourceMessageTimestamp: message.timestamp })
        if (key === currentSessionKey() && generation === currentGeneration()) {
          setGoalDraft(undefined)
          setGoalEditing(false)
          setGoalOpen(false)
          setChat((state) => (state.goal?.goalId === result.goal.goalId ? state : { ...state, goal: result.goal }))
          await optionsRef.current.refresh?.()
        }
      } catch (cause) {
        if (key === currentSessionKey() && generation === currentGeneration()) onError(String(cause))
      }
    },
    [changeMode, setChat],
  )

  const activateGoal = useCallback(
    (value: string) => {
      const command = parseGoalCommand(value)
      if (!command) return
      if (editingTimestamp !== null || editingQueue) {
        optionsRef.current.onError('请先结束消息编辑')
        return
      }
      const goal = chatStream.getSnapshot().goal
      if (command.action !== 'open' && command.action !== 'start') {
        void goalAction(command.action).catch((cause) => optionsRef.current.onError(String(cause)))
        return
      }
      setDraft((current) => command.objective || (current.trimStart().startsWith('/') ? '' : current))
      setGoalEditing(false)
      setGoalOpen(!!goal && goal.status !== 'complete')
      if (!goal || goal.status === 'complete') {
        changeMode('default')
        setGoalDraft(true)
      }
    },
    [chatStream, changeMode, goalAction, editingTimestamp, editingQueue],
  )

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
    await modeWrites.current
    await awaitPendingSwitch()
    if (isSwitching() || selectedGeneration !== currentGeneration()) return
    const goalCommand = chatStream.getSnapshot().goalsSupported ? parseGoalCommand(draft) : undefined
    if (goalCommand && goalCommand.action !== 'start') {
      if (goalCommand.action === 'open') activateGoal(draft)
      else {
        setDraft('')
        try {
          await goalAction(goalCommand.action)
        } catch (cause) {
          setDraft((current) => current || draft)
          onError(String(cause))
        }
      }
      return
    }
    const startingGoal = !!goalDraft || goalCommand?.action === 'start'
    const normalized = prepareComposerMessage(
      goalCommand?.action === 'start' ? goalCommand.objective : draft,
      startingGoal ? 'default' : modeRef.current,
    )
    const messageMode = normalized.mode
    if (messageMode !== modeRef.current) changeMode(messageMode)
    if (normalized.commandOnly) {
      setDraft(normalized.text)
      return
    }
    const message = normalized.text.trim()
    const skills = draft.includes(skillMarker)
      ? selectedSkills.map(({ name, resourceId, resourceRevision }) => ({
          name,
          id: resourceId ?? '',
          revision: resourceRevision ?? '',
        }))
      : []
    if (skills.some((skill) => !skill.id || !skill.revision)) {
      onError('技能引用已失效，请重新选择技能')
      return
    }
    const images = attachments.map(({ type, data, mimeType }) => ({ type, data, mimeType }))
    if ((!message && !images.length && !skills.length) || !canSend()) return
    if (startingGoal) {
      try {
        validateGoalInput({
          objective: message,
        })
      } catch (cause) {
        onError(String(cause))
        return
      }
      if (
        chat.running ||
        chat.paused ||
        chat.queuePaused ||
        promptPending.current ||
        editingTimestamp !== null ||
        queueEdit.current
      ) {
        onError('请等待当前会话停止后再创建目标')
        return
      }
    }
    const sessionKey = optionsRef.current.currentSessionKey()
    if (!sessionKey) return

    const queuedEdit = queueEdit.current
    if (queuedEdit) {
      if (queueEditPending.current) return
      queueEditPending.current = true
      setSavingQueue(true)
      onError('')
      try {
        await bridge.updateQueueInput(sessionKey, queuedEdit.id, message, images, skills, { mode: messageMode })
        if (
          queueEdit.current === queuedEdit &&
          sessionKey === optionsRef.current.currentSessionKey() &&
          selectedGeneration === currentGeneration()
        ) {
          queueEdit.current = null
          setEditingQueue(null)
          setDraft(queuedEdit.restore.draft)
          setSelectedSkills(queuedEdit.restore.selectedSkills)
          setPluginMentions(queuedEdit.restore.pluginMentions ?? [])
          setAttachments(queuedEdit.restore.attachments)
          changeMode(queuedEdit.mode)
        }
      } catch (cause) {
        if (sessionKey === optionsRef.current.currentSessionKey() && selectedGeneration === currentGeneration()) {
          onError(String(cause))
          try {
            await optionsRef.current.refresh?.()
          } catch {
            /* 保留编辑草稿供重试。 */
          }
        }
      } finally {
        queueEditPending.current = false
        if (sessionKey === optionsRef.current.currentSessionKey() && selectedGeneration === currentGeneration())
          setSavingQueue(false)
      }
      return
    }

    if (editingTimestamp !== null) {
      const target = editingTimestamp
      const restore = editRestore.current
      const previousMessages = chat.messages
      onError('')
      dismissComposerHint()
      setDraft('')
      setSelectedSkills([])
      setPluginMentions([])
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
          setPluginMentions(restore.pluginMentions ?? [])
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
          setPluginMentions(pluginMentions)
          setAttachments(attachments)
          setChat((value) => ({ ...value, messages: previousMessages, running: false }))
        }
        onSendFailed?.(sessionKey, {
          draft,
          selectedSkills,
          attachments,
          queueMode,
          ...(pluginMentions.length ? { pluginMentions } : {}),
        })
        if (sameSession) onError(String(cause))
      }
      return
    }

    const running = chat.running || chat.paused || chat.queuePaused || promptPending.current
    const sendMode = running ? 'followUp' : 'prompt'
    const generation = currentGeneration()
    const finishSend = optionsRef.current.onSendStarted?.(sessionKey, {
      draft,
      selectedSkills,
      attachments,
      queueMode,
      ...(pluginMentions.length ? { pluginMentions } : {}),
    })
    onError('')
    dismissComposerHint()
    setDraft('')
    setSelectedSkills([])
    setPluginMentions([])
    setAttachments([])
    if (!running) {
      promptPending.current = true
      setChat((value) => ({ ...value, running: true, activeMode: messageMode }))
    }
    try {
      if (startingGoal) {
        if (!bridge.startGoal) throw new Error('当前 Host 不支持目标')
        const result = await bridge.startGoal(sessionKey, {
          objective: message,
          images,
          skills,
        })
        if (sessionKey === optionsRef.current.currentSessionKey() && generation === currentGeneration()) {
          setGoalDraft((current) => (current === goalDraft ? undefined : current))
          setGoalOpen(false)
          setChat((state) => (state.goal?.goalId === result.goal.goalId ? state : { ...state, goal: result.goal }))
        }
      } else if (sendMode === 'followUp')
        await bridge.followUp(sessionKey, message, images, skills, { mode: messageMode })
      else {
        activeMode.current = messageMode
        await bridge.prompt(sessionKey, message, images, skills, { mode: messageMode })
      }
    } catch (cause) {
      const sameSession = sessionKey
        ? sessionKey === optionsRef.current.currentSessionKey()
        : generation === currentGeneration()
      onSendFailed?.(sessionKey, {
        draft,
        selectedSkills,
        attachments,
        queueMode,
        ...(pluginMentions.length ? { pluginMentions } : {}),
      })
      if (sameSession) {
        setDraft((value) => value || draft)
        setSelectedSkills((value) => (value.length ? value : selectedSkills))
        setPluginMentions((value) => [...new Set([...pluginMentions, ...value])])
        setAttachments((value) => (value.length ? value : attachments))
        if (!running) {
          promptPending.current = false
        }
        onError(String(cause))
      }
    } finally {
      finishSend?.()
    }
  }, [
    goalDraft,
    goalAction,
    activateGoal,
    chatStream,
    chat.running,
    chat.paused,
    chat.queuePaused,
    draft,
    selectedSkills,
    pluginMentions,
    attachments,
    queueMode,
    editingTimestamp,
    beginEditBranch,
    changeMode,
    dismissComposerHint,
    loadSnapshot,
  ])

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
      editRestore.current = {
        draft,
        selectedSkills,
        attachments,
        queueMode,
        ...(pluginMentions.length ? { pluginMentions } : {}),
      }
      setEditingTimestamp(message.timestamp)
      setDraft(restoredDraft)
      setSelectedSkills(restoredSkills)
      setPluginMentions([])
      setAttachments(images)
    },
    [chat.running, draft, selectedSkills, pluginMentions, attachments, queueMode],
  )

  const cancelEdit = useCallback(async () => {
    const queued = queueEdit.current
    if (queued) {
      if (queueEditPending.current) return
      const { bridge, currentSessionKey, currentGeneration, onError } = optionsRef.current
      const generation = currentGeneration()
      queueEditPending.current = true
      setSavingQueue(true)
      onError('')
      try {
        await bridge.cancelQueueEdit(queued.key, queued.id)
        if (queueEdit.current !== queued || queued.key !== currentSessionKey() || generation !== currentGeneration())
          return
        queueEdit.current = null
        setEditingQueue(null)
        setDraft(queued.restore.draft)
        setSelectedSkills(queued.restore.selectedSkills)
        setPluginMentions(queued.restore.pluginMentions ?? [])
        setAttachments(queued.restore.attachments)
        changeMode(queued.mode)
      } catch (cause) {
        if (queueEdit.current === queued && queued.key === currentSessionKey() && generation === currentGeneration()) {
          onError(String(cause))
          try {
            await optionsRef.current.refresh?.()
          } catch {
            /* 保留编辑内容和原草稿供重试。 */
          }
        }
      } finally {
        queueEditPending.current = false
        if (queued.key === currentSessionKey() && generation === currentGeneration()) setSavingQueue(false)
      }
      return
    }
    const restore = editRestore.current
    editRestore.current = null
    setEditingTimestamp(null)
    if (!restore) return
    setDraft(restore.draft)
    setSelectedSkills(restore.selectedSkills)
    setPluginMentions(restore.pluginMentions ?? [])
    setAttachments(restore.attachments)
    setQueueMode(restore.queueMode)
  }, [changeMode])

  const stop = useCallback(async () => {
    const { bridge, onError } = optionsRef.current
    onError('')
    try {
      const key = optionsRef.current.currentSessionKey()
      if (key) {
        if (chatStream.getSnapshot().goal?.status === 'active' && bridge.pauseGoal) await goalAction('pause')
        else await bridge.pause(key)
      }
    } catch (cause) {
      onError(String(cause))
    }
  }, [chatStream, goalAction])

  const queueAction = useCallback(
    async (action: 'resume' | 'steerQueueInput' | 'deleteQueueInput', id?: string) => {
      const { bridge, currentSessionKey, currentGeneration, onError } = optionsRef.current
      const key = currentSessionKey()
      const generation = currentGeneration()
      if (!key) return
      onError('')
      try {
        if (action === 'resume') await bridge.resume(key)
        else if (id) await bridge[action](key, id)
      } catch (cause) {
        if (key === currentSessionKey() && generation === currentGeneration()) {
          onError(String(cause))
          try {
            await optionsRef.current.refresh?.()
          } catch {
            /* 操作失败保留当前投影，后续事件或重连补读。 */
          }
        }
      }
    },
    [loadSnapshot],
  )

  const editQueueInput = useCallback(
    async (id: string) => {
      const { bridge, currentSessionKey, currentGeneration, onError } = optionsRef.current
      const key = currentSessionKey()
      const generation = currentGeneration()
      if (!key || queueEdit.current || queueEditPending.current || editingTimestamp !== null) return
      queueEditPending.current = true
      try {
        const input = await bridge.beginQueueEdit(key, id)
        if (key !== currentSessionKey() || generation !== currentGeneration()) {
          await bridge.cancelQueueEdit(key, id)
          return
        }
        const previousMode = modeRef.current
        const restored = queuedDraft(input, optionsRef.current.commands)
        queueEdit.current = { id, key, restore: latestComposer.current, mode: previousMode }
        setEditingQueue(id)
        setDraft(restored.draft)
        setSelectedSkills(restored.selectedSkills)
        setPluginMentions([])
        setAttachments(restored.attachments)
        changeMode(restored.mode)
      } catch (cause) {
        if (key === currentSessionKey() && generation === currentGeneration()) {
          onError(String(cause))
          await optionsRef.current.refresh?.()
        }
      } finally {
        queueEditPending.current = false
      }
    },
    [draft, selectedSkills, attachments, queueMode, editingTimestamp, changeMode],
  )

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
    setPluginMentions([])
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
    activateGoal,
    goalDraft,
    setGoalDraft,
    goalOpen,
    setGoalOpen,
    goalEditing,
    goalAction,
    saveGoal,
    setMessageGoal,
    recoveredInputs,
    restoreQueuedInput,
    restoreChat: setChat,
    draft,
    composerHint: visibleComposerHint({
      hint: chat.composerHint,
      dismissed: dismissedHint,
      draft,
      skills: selectedSkills.length,
      attachments: attachments.length,
      running: chat.running || chat.goal?.status === 'active',
      paused: Boolean(chat.paused || chat.queuePaused),
      queued: chat.steering.length > 0 || chat.followUp.length > 0,
      editing: editingTimestamp !== null || editingQueue !== null,
    }),
    acceptComposerHint,
    dismissComposerHint,
    setDraft,
    selectedSkills: draft.includes(skillMarker) ? selectedSkills : emptySkills,
    setSelectedSkills,
    pluginMentions,
    setPluginMentions,
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
    captureComposer: () =>
      queueEdit.current?.restore ?? {
        draft,
        goalDraft,
        selectedSkills,
        ...(pluginMentions.length ? { pluginMentions } : {}),
        attachments,
        queueMode,
        recoveredInputs,
        editing:
          editingTimestamp !== null && editRestore.current
            ? { timestamp: editingTimestamp, restore: editRestore.current }
            : undefined,
      },
    restoreComposer: (value: ComposerSnapshot) => {
      releaseQueueEdit()
      setGoalDraft(value.goalDraft)
      setGoalOpen(false)
      setGoalEditing(false)
      setDraft(value.draft)
      setSelectedSkills(value.selectedSkills)
      setPluginMentions(value.pluginMentions ?? [])
      setAttachments(value.attachments)
      setQueueMode(value.queueMode)
      setRecoveredInputs(value.recoveredInputs ?? [])
      setEditingTimestamp(value.editing?.timestamp ?? null)
      editRestore.current = value.editing?.restore ?? null
    },
    reset,
    send,
    stop,
    resume: () => queueAction('resume'),
    steerQueueInput: (id: string) => queueAction('steerQueueInput', id),
    deleteQueueInput: (id: string) => queueAction('deleteQueueInput', id),
    editQueueInput,
    editingQueue,
    savingQueue,
    clearQueue,
    editing: editingTimestamp !== null,
    editingTimestamp,
    editMessage,
    cancelEdit,
  }
}
