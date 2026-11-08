import type { VisualizationMessageContext } from '@pi-meme/contracts/visualize'
import { restoreAnnotationAttachments } from './composer/image-attachment'
import { parseGoalCommand, validateGoalInput, type GoalEdit } from '@pi-meme/contracts/goal'
import { visibleComposerHint } from './composer/composer-hint'
import { queuedDraft } from './composer/restore-queued-input'
import { ChatStream } from './model/chat-stream'
import { messageAttachmentParts } from './model/message-attachments'
import type { ChatState } from './model/types'
import { prepareComposerMessage } from './composer/plan-input'
import { SessionMode } from './composer/session-mode'
import {
  normalizePlanMessage,
  type TaskMode,
  type QueuedInput,
  type MessageConfiguration,
  type PlanAction,
  type MessageOptions,
} from '@pi-meme/contracts/plan'
import { skillMarker, skillMessageParts } from '@pi-meme/contracts/skills'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ComposerDraftStore, type ComposerDraftState } from './composer/composer-state'
import { useComposerFiles } from './composer/use-composer-files'
import type { ComposerIntent, ComposerProcessingRecord } from '@pi-meme/plugin-sdk/composer'
import type { ChatBridge, DesktopEvent, Snapshot } from '@pi-meme/contracts/desktop'
import { builtinCommand, freshSessionCommandError, type PiEvent, type PiSlashCommand } from '@pi-meme/contracts/pi'
import { applyEvent as reduceEvent, emptyChat, restoreSnapshot } from './model/state'
import { messageWithAttachments, type ComposerAttachment as Attachment } from './composer/image-attachment'

const emptySkills: PiSlashCommand[] = []

function sameBashOutputDetails(before: unknown, after: unknown) {
  if (before === undefined || after === undefined) return before === after
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return false
  if (Array.isArray(before) || Array.isArray(after)) return false
  const keys = Object.keys(after)
  return (
    keys.length === Object.keys(before).length &&
    keys.every(
      (key) =>
        (key === 'truncation' || key === 'fullOutputPath') &&
        Object.hasOwn(before, key) &&
        Object.is(Reflect.get(before, key), Reflect.get(after, key)),
    )
  )
}

function isPlainToolOutput(state: ChatState, event: Parameters<typeof reduceEvent>[1]) {
  if (event.type !== 'tool_execution_update' || event.toolName !== 'bash' || event.source) return false
  const previous = state.tools[event.toolCallId]
  if (
    !previous ||
    previous.status !== 'running' ||
    previous.name !== event.toolName ||
    previous.source ||
    (event.parentToolCallId ?? previous.parentToolCallId) !== previous.parentToolCallId
  )
    return false
  // 只合并内置 Bash 的纯正文。参数、来源或结构化详情变化仍立即呈现。
  const before = previous.args
  const after = event.args
  if (before !== after) {
    if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return false
    const keys = Object.keys(before)
    if (
      keys.length !== Object.keys(after).length ||
      keys.some((key) => !Object.hasOwn(after, key) || !Object.is(Reflect.get(before, key), Reflect.get(after, key)))
    )
      return false
  }
  const result = event.partialResult
  return (
    result != null &&
    typeof result === 'object' &&
    sameBashOutputDetails(
      previous.result && typeof previous.result === 'object' ? Reflect.get(previous.result, 'details') : undefined,
      result.details,
    ) &&
    Array.isArray(result.content) &&
    result.content.every(
      (part: unknown) => part != null && typeof part === 'object' && 'type' in part && part.type === 'text',
    )
  )
}

export type QueueMode = 'steering' | 'followUp'

export type ComposerSnapshot = {
  selection?: { anchor: number; focus: number } | null
  planDraft?: string
  goalDraft?: true
  draft: string
  selectedSkills: PiSlashCommand[]
  pluginMentions?: string[]
  pluginAnchors?: Record<string, number>
  attachments: Attachment[]
  queueMode: QueueMode
  recoveredInputs?: QueuedInput[]
  pendingConfiguration?: MessageConfiguration
  editing?: { entryId: string; configuration?: MessageConfiguration; restore: Omit<ComposerSnapshot, 'editing'> }
}

export type ChatSessionOptions = {
  submitPlan?: (sessionKey: string, text: string, options: MessageOptions, idempotencyKey: string) => Promise<void>
  bridge: ChatBridge
  configuration?: () => MessageConfiguration
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
  onModeConfirmed?: (sessionKey: string, generation: number, mode: TaskMode) => void
  onError: (message: string) => void
  /** 编辑期间切换会话时，将结果保存回原会话的窗口草稿。 */
  onBackgroundEdit?: (sessionKey: string, composer: ComposerSnapshot) => void
  /** 请求返回前保留待发送草稿；返回的函数在请求结束后释放保留记录。 */
  onSendStarted?: (sessionKey: string, composer: ComposerSnapshot) => (accepted?: boolean) => void
  /** 发送失败并回滚草稿后触发，由 desktop 重新读取快照。 */
  onSendFailed?: (sessionKey: string | undefined, composer: ComposerSnapshot) => void
}

/**
 * 聊天数据、草稿、附件与发送行为。连接、快照与事件订阅由 desktop 协调。
 */
export function useChatSession(options: ChatSessionOptions) {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [chat, setRenderedChat] = useState(emptyChat)
  const [chatStream] = useState(() => new ChatStream(emptyChat))
  const [scrollRequest, setScrollRequest] = useState<{ sessionKey: string; version: number }>()
  const setChat = useCallback(
    (value: ChatState | ((state: ChatState) => ChatState)) => {
      chatStream.update(value)
      setRenderedChat(chatStream.getSnapshot())
    },
    [chatStream],
  )
  const [composerStore] = useState(() => new ComposerDraftStore())
  const composerState = useSyncExternalStore(
    composerStore.subscribe,
    composerStore.getSnapshot,
    composerStore.getSnapshot,
  )
  const { draft, selectedSkills, pluginMentions, pluginAnchors, attachments, queueMode } = composerState
  const { setDraft, setSelectedSkills, setPluginMentions, setAttachments, setQueueMode } = composerStore
  const submissionIntegration = useRef<{
    blocked: () => string | undefined
    isPreparedCurrent?: () => boolean
    prepare: (
      value: ComposerDraftState,
      intent: ComposerIntent,
      signal: AbortSignal,
    ) => Promise<{ composer: ComposerDraftState; records: readonly ComposerProcessingRecord[] } | null>
  } | null>(null)
  const preparingSubmission = useRef(false)
  const planSubmissions = useRef(new Map<string, { fingerprint: string; id: string; options: MessageOptions }>())
  const [sendingAttachments, setSendingAttachments] = useState<Attachment[]>([])
  const [failedDrafts, setFailedDrafts] = useState<Array<{ sessionKey: string; composer: ComposerSnapshot }>>([])
  const [planDraft, setPlanDraft] = useState('')
  const [goalDraft, setGoalDraft] = useState<ComposerSnapshot['goalDraft']>()
  const [goalOpen, setGoalOpen] = useState(false)
  const [goalEditing, setGoalEditing] = useState(false)
  const [dismissedHint, setDismissedHint] = useState<string | undefined>(undefined)
  const hintSession = useRef<string | undefined>(undefined)
  const composerHintRef = useRef<string | undefined>(undefined)
  const [mode, setMode] = useState<TaskMode>('default')
  const modeWrites = useRef<Promise<unknown>>(Promise.resolve())
  const pendingMode = useRef<{
    key: string
    generation: number
    mode: TaskMode
    promise: Promise<boolean>
  } | null>(null)
  const [modeChange, setModeChange] = useState<{ key: string; generation: number } | null>(null)
  const modeRef = useRef<TaskMode>('default')
  const modes = useRef(new SessionMode())
  const activeMode = useRef<TaskMode | undefined>(undefined)
  const [recoveredInputs, setRecoveredInputs] = useState<QueuedInput[]>([])
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null)
  const [pendingConfiguration, setPendingConfiguration] = useState<MessageConfiguration>()
  const [editConfiguration, setEditConfiguration] = useState<MessageConfiguration>()
  const configurationRef = useRef<MessageConfiguration | undefined>(undefined)
  const editPending = useRef<{ key: string; generation: number } | null>(null)
  const [editRequest, setEditRequest] = useState<{ key: string; generation: number } | null>(null)
  const editRestore = useRef<ComposerSnapshot | null>(null)
  const [editingQueue, setEditingQueue] = useState<string | null>(null)
  const queueEdit = useRef<{ id: string; key: string; restore: ComposerSnapshot; mode: TaskMode } | null>(null)
  const queueEditPending = useRef(false)
  const [savingQueue, setSavingQueue] = useState(false)
  const latestComposer = useRef<ComposerSnapshot>({ draft, selectedSkills, attachments, queueMode })
  latestComposer.current = {
    draft,
    planDraft,
    goalDraft,
    selectedSkills,
    attachments,
    queueMode,
    pendingConfiguration,
    ...(pluginMentions.length ? { pluginMentions, pluginAnchors } : {}),
  }
  const promptPending = useRef(false)
  const recoveryPending = useRef<{ key: string; generation: number } | null>(null)
  const [recoveryRequest, setRecoveryRequest] = useState<{ key: string; generation: number } | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options
  composerHintRef.current = chat.composerHint
  const selectedConfiguration = editConfiguration ?? pendingConfiguration ?? options.configuration?.() ?? {}
  configurationRef.current = selectedConfiguration
  const updateConfiguration = (update: MessageConfiguration) => {
    if (editPending.current) return
    const next = { ...configurationRef.current, ...update }
    configurationRef.current = next
    if (editingEntryId !== null) setEditConfiguration(next)
    else setPendingConfiguration(next)
  }
  const actualConfiguration = options.configuration?.() ?? {}
  const configurationChanged = Boolean(
    pendingConfiguration &&
    (pendingConfiguration.model?.provider !== actualConfiguration.model?.provider ||
      pendingConfiguration.model?.id !== actualConfiguration.model?.id ||
      pendingConfiguration.thinkingLevel !== actualConfiguration.thinkingLevel),
  )
  const editSubmitting =
    editRequest?.key === options.currentSessionKey() && editRequest?.generation === options.currentGeneration()
  const composerFiles = useComposerFiles({
    contextKey: JSON.stringify([
      options.currentGeneration(),
      options.currentSessionKey(),
      editingEntryId,
      editingQueue,
    ]),
    sessionKey: options.currentSessionKey(),
    disabled: !options.canSend(),
    uploadAttachment: options.bridge.uploadAttachment,
    onAdd: (images) => composerStore.setAttachments((value) => [...value, ...images]),
    onError: options.onError,
  })

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
      const nextMode = modes.current.snapshot(
        key,
        snapshot.connection.generation,
        snapshot.state.mode,
        readModeRevision,
      )
      modeRef.current = nextMode
      setMode(nextMode)
      return merged
    },
    [chatStream, setChat],
  )

  const applyEvent = useCallback(
    (event: Parameters<typeof reduceEvent>[1]) => {
      const frame = isPlainToolOutput(chatStream.getSnapshot(), event)
      chatStream.update((value) => reduceEvent(value, event), frame ? 'frame' : 'immediate')
      // 已确认的纯输出由对话自己订阅；其他工具更新和语义事件仍同步控制区。
      if (event.type !== 'message_update' && !frame) setRenderedChat(chatStream.getSnapshot())
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
    setPlanDraft('')
    setGoalOpen(false)
    setGoalEditing(false)
    setDraft('')
    setSelectedSkills([])
    setPluginMentions([])
    setAttachments([])
    setRecoveredInputs([])
    setEditingEntryId(null)
    setEditConfiguration(undefined)
    setPendingConfiguration(undefined)
    editRestore.current = null
  }, [releaseQueueEdit])

  const reset = useCallback(() => {
    releaseQueueEdit()
    setChat(emptyChat)
    setDraft('')
    setSelectedSkills([])
    setPluginMentions([])
    setAttachments([])
    setSendingAttachments([])
    promptPending.current = false
    setEditingEntryId(null)
    setEditConfiguration(undefined)
    setPendingConfiguration(undefined)
    editRestore.current = null
  }, [releaseQueueEdit])

  const clearPromptPending = useCallback(() => {
    promptPending.current = false
  }, [])

  const changeMode = useCallback(
    (next: TaskMode) => {
      const { bridge, currentSessionKey, currentGeneration, onModeConfirmed } = optionsRef.current
      const key = currentSessionKey()
      const generation = currentGeneration()
      if (!key) return Promise.resolve(false)
      const previous = pendingMode.current
      if (previous?.key === key && previous.generation === generation && previous.mode === next) return previous.promise
      const request = { key, generation }
      const owns = () =>
        mounted.current &&
        optionsRef.current.bridge === bridge &&
        key === optionsRef.current.currentSessionKey() &&
        generation === optionsRef.current.currentGeneration()
      const pausesGoal = next === 'plan' && chatStream.getSnapshot().goal?.status === 'active'
      const pending: Promise<boolean> = modeWrites.current
        .catch(() => {})
        .then(async () => {
          if (!owns()) return false
          await bridge.setSessionMode(key, next)
          if (mounted.current && optionsRef.current.bridge === bridge) {
            modes.current.confirm(key, generation, next)
            onModeConfirmed?.(key, generation, next)
          }
          if (!owns()) return false
          modeRef.current = next
          setMode(next)
          if (next === 'plan' && pendingMode.current?.promise === pending) setGoalDraft(undefined)
          if (pausesGoal) {
            const cleared = await bridge.clearQueue(key)
            if (owns()) setRecoveredInputs((current) => [...current, ...cleared.steering, ...cleared.followUp])
          }
          return true
        })
        .catch((cause) => {
          if (owns() && pendingMode.current?.promise === pending)
            optionsRef.current.onError(`无法保存计划模式：${String(cause)}`)
          return false
        })
        .finally(async () => {
          if (owns() && pendingMode.current?.promise === pending)
            await optionsRef.current.refresh?.().catch((cause) => {
              if (owns()) optionsRef.current.onError(String(cause))
            })
          if (pendingMode.current?.promise === pending) pendingMode.current = null
          if (mounted.current) setModeChange((current) => (current === request ? null : current))
        })
      modeWrites.current = pending
      pendingMode.current = { ...request, mode: next, promise: pending }
      setModeChange(request)
      return pending
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
      if (!operation) throw new Error('当前服务不支持目标')
      const next = await operation(
        key,
        action === 'resume' ? { ...goal, configuration: configurationRef.current } : goal,
      )
      if (action === 'clear' && !owns()) return
      if (owns()) {
        setChat((state) => ({ ...state, goal: next || undefined }))
        setGoalEditing(action === 'edit')
        setGoalOpen(action !== 'clear')
      }
      if (action !== 'resume' && action !== 'pause' && bridge.clearQueue) {
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
      if (!key || !bridge.editGoal) throw new Error('当前服务不支持目标')
      const goal = await bridge.editGoal(key, input)
      if (key === currentSessionKey() && generation === currentGeneration()) {
        setChat((state) => ({ ...state, goal }))
        setGoalEditing(false)
      }
    },
    [setChat],
  )

  const activateGoal = useCallback(
    (value: string) => {
      const command = parseGoalCommand(value)
      if (!command) return
      if (editingEntryId !== null || editingQueue) {
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
    [chatStream, changeMode, goalAction, editingEntryId, editingQueue],
  )

  const activatePlan = useCallback(
    (value: string) => {
      const key = optionsRef.current.currentSessionKey()
      const generation = optionsRef.current.currentGeneration()
      setDraft(value)
      const revision = composerStore.getSnapshot().revision
      void changeMode('plan').then((saved) => {
        if (
          saved &&
          mounted.current &&
          key === optionsRef.current.currentSessionKey() &&
          generation === optionsRef.current.currentGeneration() &&
          revision === composerStore.getSnapshot().revision &&
          modeRef.current === 'plan'
        )
          setDraft(normalizePlanMessage(value, 'plan').text)
      })
    },
    [changeMode, composerStore],
  )

  const compactNow = useCallback(async () => {
    const {
      bridge,
      canSend,
      isSwitching,
      awaitPendingSwitch,
      currentGeneration,
      currentSessionKey,
      onError,
      onSendFailed,
    } = optionsRef.current
    await awaitPendingSwitch()
    if (!chat.messages.length && !chat.live) {
      onError(freshSessionCommandError('compact'))
      return
    }
    const sessionKey = currentSessionKey()
    const busy =
      !sessionKey ||
      isSwitching() ||
      promptPending.current ||
      chat.running ||
      Boolean(chat.compacting?.active) ||
      chat.paused ||
      chat.queuePaused ||
      editingEntryId !== null ||
      queueEdit.current !== null
    if (busy) {
      onError('Pi 正在运行或切换，请等待完成后重试')
      return
    }
    if (!canSend()) {
      onError('当前模型已不可用，请先重新选择模型')
      return
    }
    const generation = currentGeneration()
    onError('')
    promptPending.current = true
    setChat((value) => ({ ...value, running: true }))
    try {
      await bridge.prompt(sessionKey, '/compact', [], [], { mode: modeRef.current })
    } catch (cause) {
      const sameSession =
        sessionKey === optionsRef.current.currentSessionKey() && generation === optionsRef.current.currentGeneration()
      if (!sameSession) return
      promptPending.current = false
      setChat((value) => ({ ...value, running: value.compacting?.active ? value.running : false }))
      onError(String(cause))
      onSendFailed?.(sessionKey, latestComposer.current)
    }
  }, [
    chat.compacting?.active,
    chat.live,
    chat.messages.length,
    chat.paused,
    chat.queuePaused,
    chat.running,
    editingEntryId,
  ])

  const dispatchComposer = useCallback(
    async (
      prepared?: ComposerDraftState,
      records: readonly ComposerProcessingRecord[] = [],
      submittedConfiguration: MessageConfiguration = { ...configurationRef.current },
      feedback = false,
      visualization?: VisualizationMessageContext,
    ) => {
      const sourceRevision = composerStore.getSnapshot().revision
      const planAction = prepared?.plan
      const { draft, selectedSkills, pluginMentions, attachments, queueMode } = prepared ?? composerStore.getSnapshot()
      const { bridge, canSend, isSwitching, awaitPendingSwitch, currentGeneration, onError, onSendFailed } =
        optionsRef.current
      const selectedGeneration = currentGeneration()
      const selectedKey = optionsRef.current.currentSessionKey()
      const modePending = () =>
        pendingMode.current?.key === selectedKey && pendingMode.current?.generation === selectedGeneration
      let savedMode = true
      while (modePending()) {
        savedMode = await pendingMode.current!.promise
      }
      if (!savedMode) return false
      const selectedMode = modeRef.current
      await awaitPendingSwitch()
      const goalCommand = !planAction && chatStream.getSnapshot().goalsSupported ? parseGoalCommand(draft) : undefined
      const controlOnly = goalCommand && goalCommand.action !== 'start'
      if (
        isSwitching() ||
        modePending() ||
        selectedMode !== modeRef.current ||
        selectedKey !== optionsRef.current.currentSessionKey() ||
        (!controlOnly && submissionIntegration.current?.isPreparedCurrent?.() === false) ||
        sourceRevision !== composerStore.getSnapshot().revision ||
        composerStore.getSnapshot().composing ||
        composerFiles.isUploading() ||
        submissionIntegration.current?.blocked() ||
        selectedGeneration !== currentGeneration() ||
        (recoveryPending.current?.key === optionsRef.current.currentSessionKey() &&
          recoveryPending.current?.generation === selectedGeneration)
      )
        return false
      if (controlOnly) {
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
        return false
      }
      const startingGoal = !feedback && !planAction && (!!goalDraft || goalCommand?.action === 'start')
      const normalized = planAction
        ? {
            text: draft,
            mode: planAction.intent === 'execute' ? ('default' as const) : ('plan' as const),
            commandOnly: false,
          }
        : prepareComposerMessage(
            goalCommand?.action === 'start' ? goalCommand.objective : draft,
            startingGoal ? 'default' : modeRef.current,
          )
      const messageMode = normalized.mode
      if (!planAction && messageMode !== modeRef.current) {
        if (!(await changeMode(messageMode))) return false
        if (
          isSwitching() ||
          modePending() ||
          selectedKey !== optionsRef.current.currentSessionKey() ||
          selectedGeneration !== currentGeneration() ||
          sourceRevision !== composerStore.getSnapshot().revision ||
          modeRef.current !== messageMode
        )
          return false
      }
      if (normalized.commandOnly) {
        setDraft(normalized.text)
        return false
      }
      const slashCommand = planAction ? undefined : builtinCommand(normalized.text)
      if (slashCommand) {
        const currentChat = chatStream.getSnapshot()
        if (!currentChat.messages.length && !currentChat.live) {
          onError(freshSessionCommandError(slashCommand.name))
          return false
        }
        if (
          currentChat.running ||
          currentChat.paused ||
          currentChat.queuePaused ||
          currentChat.compacting?.active ||
          editingEntryId !== null ||
          queueEdit.current
        ) {
          onError('Pi 正在运行或切换，请等待完成后重试')
          return false
        }
      }
      const audit = {
        ...(records.length ? { clientProcessingAudit: records } : {}),
        ...(planAction ? { plan: planAction } : {}),
      }
      const { message, images } = messageWithAttachments(normalized.text.trim(), attachments)
      const skills = draft.includes(skillMarker)
        ? selectedSkills.map(({ name, resourceId, resourceRevision }) => ({
            name,
            id: resourceId ?? '',
            revision: resourceRevision ?? '',
          }))
        : []
      if (skills.some((skill) => !skill.id || !skill.revision)) {
        onError('技能引用已失效，请重新选择技能')
        return false
      }
      if ((!message && !images.length && !skills.length) || !canSend()) return false
      const currentChat = chatStream.getSnapshot()
      if (startingGoal) {
        try {
          validateGoalInput({
            objective: message,
          })
        } catch (cause) {
          onError(String(cause))
          return false
        }
        if (
          currentChat.running ||
          currentChat.paused ||
          currentChat.queuePaused ||
          promptPending.current ||
          editingEntryId !== null ||
          queueEdit.current
        ) {
          onError('请等待当前会话停止后再创建目标')
          return false
        }
      }
      const sessionKey = optionsRef.current.currentSessionKey()
      if (!sessionKey) return false

      const queuedEdit = queueEdit.current
      if (queuedEdit) {
        if (queueEditPending.current) return false
        queueEditPending.current = true
        setSavingQueue(true)
        onError('')
        try {
          await bridge.updateQueueInput(sessionKey, queuedEdit.id, message, images, skills, {
            mode: messageMode,
            ...audit,
            ...submittedConfiguration,
            ...(visualization ? { visualization } : {}),
          })
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
            setPendingConfiguration(queuedEdit.restore.pendingConfiguration)
            changeMode(queuedEdit.mode)
          }
          return true
        } catch (cause) {
          if (sessionKey === optionsRef.current.currentSessionKey() && selectedGeneration === currentGeneration()) {
            onError(String(cause))
            try {
              await optionsRef.current.refresh?.()
            } catch {
              /* 保留编辑草稿供重试。 */
            }
          }
          return false
        } finally {
          queueEditPending.current = false
          if (sessionKey === optionsRef.current.currentSessionKey() && selectedGeneration === currentGeneration())
            setSavingQueue(false)
        }
      }

      if (editingEntryId !== null) {
        if (editPending.current) return false
        const target = editingEntryId
        const restore = editRestore.current
        const request = { key: sessionKey, generation: selectedGeneration }
        const configuration = { ...configurationRef.current }
        const savedEditor: ComposerSnapshot = {
          planDraft,
          draft,
          selectedSkills,
          pluginMentions,
          attachments,
          queueMode,
          pendingConfiguration,
          editing: { entryId: target, configuration, restore: restore ?? latestComposer.current },
        }
        const previousRecovered = recoveredInputs
        editPending.current = request
        setEditRequest(request)
        const owns = () =>
          sessionKey === optionsRef.current.currentSessionKey() &&
          selectedGeneration === optionsRef.current.currentGeneration()
        onError('')
        dismissComposerHint()
        try {
          const result = await bridge.editAndPrompt(sessionKey, target, message, images, skills, {
            mode: messageMode,
            ...audit,
            ...configuration,
          })
          if (owns()) setRecoveredInputs((values) => [...values, ...result.recoveredInputs])
          else
            optionsRef.current.onBackgroundEdit?.(sessionKey, {
              ...(result.error
                ? savedEditor
                : (restore ?? { draft: '', selectedSkills: [], attachments: [], queueMode })),
              recoveredInputs: [...previousRecovered, ...result.recoveredInputs],
            })
          if (result.error) throw new Error(result.error)
          if (owns()) {
            setEditingEntryId(null)
            editRestore.current = null
            setEditConfiguration(undefined)
            setPendingConfiguration(undefined)
            if (sourceRevision === composerStore.getSnapshot().revision) {
              composerStore.patch(restore ?? { draft: '', selectedSkills: [], pluginMentions: [], attachments: [] })
            }
            await optionsRef.current.refresh?.()
          }
          return true
        } catch (cause) {
          // Host 的真实快照决定执行状态，保留编辑草稿，不伪造旧任务已经恢复。
          if (owns()) {
            onError(String(cause))
            await optionsRef.current.refresh?.().catch(() => {})
          }
          return false
        } finally {
          if (editPending.current === request) editPending.current = null
          setEditRequest((current) => (current === request ? null : current))
        }
      }

      const running =
        !currentChat.stopped &&
        (currentChat.running || currentChat.paused || currentChat.queuePaused || promptPending.current)
      if (planAction && (running || editingEntryId !== null || queueEdit.current)) return false
      const sendMode = running ? 'followUp' : 'prompt'
      const generation = currentGeneration()
      setScrollRequest((previous) => ({ sessionKey, version: (previous?.version ?? 0) + 1 }))
      const finishSend =
        !feedback && !planAction
          ? optionsRef.current.onSendStarted?.(sessionKey, {
              draft,
              selectedSkills,
              attachments,
              queueMode,
              ...(pluginMentions.length ? { pluginMentions } : {}),
            })
          : undefined
      if (attachments.length > 0) setSendingAttachments((current) => [...current, ...attachments])
      onError('')
      dismissComposerHint()
      if (!feedback && !planAction)
        composerStore.patch({ draft: '', selectedSkills: [], pluginMentions: [], attachments: [] })
      let accepted = false
      const clearedRevision = composerStore.getSnapshot().revision
      if (!running) {
        promptPending.current = true
        setChat((value) => ({ ...value, running: true, activeMode: messageMode }))
      }
      try {
        if (planAction && optionsRef.current.submitPlan) {
          const key = `${sessionKey}:${planAction.reference.id}:${planAction.intent}`
          const fingerprint = JSON.stringify([
            message,
            planAction,
            submittedConfiguration.model?.provider,
            submittedConfiguration.model?.id,
            submittedConfiguration.thinkingLevel,
          ])
          let attempt = planSubmissions.current.get(key)
          if (attempt?.fingerprint !== fingerprint) {
            attempt = {
              fingerprint,
              id: crypto.randomUUID(),
              options: { mode: messageMode, ...audit, ...submittedConfiguration },
            }
            planSubmissions.current.set(key, attempt)
          }
          await optionsRef.current.submitPlan(sessionKey, message, attempt.options, attempt.id)
          planSubmissions.current.delete(key)
        } else if (startingGoal) {
          if (!bridge.startGoal) throw new Error('当前服务不支持目标')
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
          await bridge.followUp(sessionKey, message, images, skills, {
            mode: messageMode,
            ...audit,
            ...submittedConfiguration,
            ...(visualization ? { visualization } : {}),
          })
        else {
          activeMode.current = messageMode
          await bridge.prompt(sessionKey, message, images, skills, {
            mode: messageMode,
            ...audit,
            ...submittedConfiguration,
            ...(visualization ? { visualization } : {}),
          })
        }
        accepted = true
        if (planAction && sessionKey === optionsRef.current.currentSessionKey() && generation === currentGeneration())
          changeMode(messageMode)
        return true
      } catch (cause) {
        const sameSession = sessionKey
          ? sessionKey === optionsRef.current.currentSessionKey()
          : generation === currentGeneration()
        if (!feedback && !planAction)
          onSendFailed?.(sessionKey, {
            draft,
            selectedSkills,
            attachments,
            queueMode,
            ...(pluginMentions.length ? { pluginMentions } : {}),
          })
        if (sameSession) {
          if (!feedback && !planAction && composerStore.getSnapshot().revision === clearedRevision)
            composerStore.patch({ draft, selectedSkills, pluginMentions, attachments, queueMode })
          else if (!feedback && !planAction)
            setFailedDrafts((values) => [
              ...values,
              { sessionKey, composer: { draft, selectedSkills, pluginMentions, attachments, queueMode } },
            ])
          if (!running) {
            promptPending.current = false
            if (planAction) {
              if (optionsRef.current.refresh) await optionsRef.current.refresh().catch(() => {})
              else setChat((value) => ({ ...value, running: false, activeMode: undefined }))
            }
          }
          onError(String(cause))
        }
        return false
      } finally {
        if (attachments.length > 0)
          setSendingAttachments((current) => current.filter((item) => !attachments.includes(item)))
        finishSend?.(accepted)
      }
    },
    [
      goalDraft,
      goalAction,
      activateGoal,
      chatStream,
      draft,
      planDraft,
      selectedSkills,
      pluginMentions,
      attachments,
      queueMode,
      editingEntryId,
      pendingConfiguration,
      recoveredInputs,
      changeMode,
      dismissComposerHint,
      loadSnapshot,
    ],
  )

  const requestSubmit = useCallback(
    async (plan?: PlanAction, text?: string, feedback = false, visualization?: VisualizationMessageContext) => {
      if (feedback && (editingEntryId !== null || queueEdit.current)) return false
      if (preparingSubmission.current || editPending.current || (plan && promptPending.current)) return false
      const original = composerStore.getSnapshot()
      const source: ComposerDraftState =
        plan || feedback
          ? {
              ...original,
              plan,
              draft: text ?? '请实施此计划。',
              selectedSkills: [],
              pluginMentions: [],
              pluginAnchors: {},
              attachments: [],
            }
          : original
      if (plan && (chatStream.getSnapshot().running || editingEntryId !== null || queueEdit.current)) return false
      const submittedConfiguration = { ...configurationRef.current }
      const integration = submissionIntegration.current
      if (source.composing || composerFiles.isUploading() || integration?.blocked()) return false
      const controller = new AbortController()
      const unsubscribe = composerStore.subscribe(() => {
        if (composerStore.getSnapshot().revision !== source.revision || composerStore.getSnapshot().composing)
          controller.abort(new Error('草稿已变化，尚未发送'))
      })
      preparingSubmission.current = true
      let ownsPreparation = true
      try {
        const goalCommand =
          !plan && !feedback && chatStream.getSnapshot().goalsSupported ? parseGoalCommand(source.draft) : undefined
        const controlOnly = goalCommand && goalCommand.action !== 'start'
        const intent: ComposerIntent =
          editingEntryId !== null
            ? 'edit-message'
            : queueEdit.current
              ? 'edit-queue'
              : !plan && !feedback && (goalDraft || goalCommand?.action === 'start')
                ? 'start-goal'
                : 'message'
        const prepared =
          integration && !controlOnly
            ? await integration.prepare(source, intent, controller.signal)
            : { composer: source, records: [] }
        if (!prepared || controller.signal.aborted || source.revision !== composerStore.getSnapshot().revision)
          return false
        unsubscribe()
        preparingSubmission.current = false
        ownsPreparation = false
        return await dispatchComposer(
          prepared.composer,
          prepared.records,
          submittedConfiguration,
          feedback,
          visualization,
        )
      } finally {
        unsubscribe()
        if (ownsPreparation) preparingSubmission.current = false
      }
    },
    [composerStore, chatStream, editingEntryId, goalDraft, dispatchComposer],
  )

  const send = useCallback(async () => {
    await requestSubmit()
  }, [requestSubmit])

  const editMessage = useCallback(
    (message: Extract<PiEvent, { type: 'message_end' }>['message']) => {
      if (
        message.role !== 'user' ||
        !message.sourceEntry ||
        editingEntryId !== null ||
        editPending.current ||
        queueEdit.current
      )
        return
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
      const parts = messageAttachmentParts(text)
      const restoredAnnotations = restoreAnnotationAttachments(
        parts.text,
        images.filter(
          (item): item is import('./composer/image-attachment').ComposerImageAttachment => item.type === 'image',
        ),
      )
      const restoredSkills: PiSlashCommand[] = []
      const restoredDraft = skillMessageParts(restoredAnnotations.text)
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
        planDraft,
        draft,
        selectedSkills,
        attachments,
        queueMode,
        ...(pluginMentions.length ? { pluginMentions } : {}),
      }
      setEditingEntryId(message.sourceEntry.id)
      setEditConfiguration({ ...configurationRef.current })
      setDraft(restoredDraft)
      setSelectedSkills(restoredSkills)
      setPluginMentions([])
      setAttachments([
        ...restoredAnnotations.attachments,
        ...parts.attachments.map((file) => ({ ...file, id: crypto.randomUUID(), type: 'file' as const })),
      ])
    },
    [editingEntryId, draft, planDraft, selectedSkills, pluginMentions, attachments, queueMode],
  )

  const cancelEdit = useCallback(async () => {
    if (editPending.current) return
    setEditConfiguration(undefined)
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
        setPendingConfiguration(queued.restore.pendingConfiguration)
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
    setEditingEntryId(null)
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
    const key = optionsRef.current.currentSessionKey()
    const generation = optionsRef.current.currentGeneration()
    try {
      if (key) {
        if (chatStream.getSnapshot().goal?.status === 'active' && bridge.pauseGoal) await goalAction('pause')
        else await bridge.stopTask(key)
      }
    } catch (cause) {
      onError(String(cause))
    } finally {
      if (
        key &&
        key === optionsRef.current.currentSessionKey() &&
        generation === optionsRef.current.currentGeneration()
      ) {
        try {
          await optionsRef.current.refresh?.()
        } catch (cause) {
          onError(`无法同步停止后的会话：${String(cause)}`)
        }
      }
    }
  }, [chatStream, goalAction])

  const recover = useCallback(async () => {
    const { bridge, canSend, isSwitching, currentSessionKey, currentGeneration } = optionsRef.current
    const key = currentSessionKey()
    const generation = currentGeneration()
    const state = chatStream.getSnapshot()
    const composer = latestComposer.current
    if (
      !key ||
      !state.recovery ||
      (state.goal && state.goal.status !== 'complete') ||
      !canSend() ||
      isSwitching() ||
      state.running ||
      state.paused ||
      state.queuePaused ||
      promptPending.current ||
      editingEntryId !== null ||
      queueEdit.current ||
      queueEditPending.current ||
      composer.draft.trim() ||
      composer.attachments.length ||
      composer.selectedSkills.length ||
      (recoveryPending.current?.key === key && recoveryPending.current.generation === generation)
    )
      return
    const request = { key, generation }
    recoveryPending.current = request
    setRecoveryRequest(request)
    const owns = () => {
      const current = optionsRef.current
      return key === current.currentSessionKey() && generation === current.currentGeneration()
    }
    let failed = false
    optionsRef.current.onError('')
    try {
      await bridge.recover(key, state.recovery.entryId)
    } catch (cause) {
      failed = true
      if (owns()) optionsRef.current.onError(String(cause))
    } finally {
      try {
        if (owns()) await optionsRef.current.refresh?.()
      } catch (cause) {
        if (owns() && !failed) optionsRef.current.onError(`无法同步恢复后的会话：${String(cause)}`)
      } finally {
        if (recoveryPending.current === request) {
          recoveryPending.current = null
          setRecoveryRequest(null)
        }
      }
    }
  }, [chatStream, editingEntryId])

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
      if (!key || queueEdit.current || queueEditPending.current || editingEntryId !== null) return
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
        setPendingConfiguration(input.configuration)
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
    [draft, selectedSkills, attachments, queueMode, editingEntryId, changeMode],
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

  const resume = async () => {
    if (chatStream.getSnapshot().goal?.status === 'paused') {
      await goalAction('resume')
      return
    }
    if (chatStream.getSnapshot().stopped) {
      const key = optionsRef.current.currentSessionKey()
      if (!key) return
      try {
        await optionsRef.current.bridge.continueStopped(key, configurationRef.current)
      } catch (cause) {
        optionsRef.current.onError(String(cause))
      }
      return
    }
    await queueAction('resume')
  }

  return {
    chat,
    chatStream,
    scrollToBottomVersion:
      scrollRequest && scrollRequest.sessionKey === options.currentSessionKey() ? scrollRequest.version : 0,
    composerStore,
    composerFiles,
    canSubmitComposer: () =>
      optionsRef.current.canSend() &&
      !composerFiles.isUploading() &&
      !composerStore.getSnapshot().composing &&
      !submissionIntegration.current?.blocked(),
    setSubmissionIntegration: (integration: typeof submissionIntegration.current) => {
      submissionIntegration.current = integration
    },
    dispatchPreparedComposer: dispatchComposer,
    failedDrafts: failedDrafts
      .filter((item) => item.sessionKey === options.currentSessionKey())
      .map((item) => item.composer),
    restoreFailedDraft: (index: number) => {
      const failed = failedDrafts.filter((item) => item.sessionKey === optionsRef.current.currentSessionKey())[index]
      const value = failed?.composer
      const current = composerStore.getSnapshot()
      if (
        !value ||
        current.draft.trim() ||
        current.attachments.length ||
        current.selectedSkills.length ||
        current.pluginMentions.length
      )
        return
      composerStore.patch({
        draft: value.draft,
        selectedSkills: value.selectedSkills,
        pluginMentions: value.pluginMentions ?? [],
        attachments: value.attachments,
        queueMode: value.queueMode,
      })
      setFailedDrafts((values) => values.filter((item) => item !== failed))
    },
    captureChat: chatStream.getSnapshot,
    captureMode: () => modeRef.current,
    mode,
    modeChanging:
      modeChange?.key === options.currentSessionKey() && modeChange?.generation === options.currentGeneration(),
    changeMode,
    activatePlan,
    activateGoal,
    compactNow,
    goalDraft,
    setGoalDraft,
    goalOpen,
    setGoalOpen,
    goalEditing,
    goalAction,
    saveGoal,
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
      editing: editingEntryId !== null || editingQueue !== null,
    }),
    acceptComposerHint,
    dismissComposerHint,
    setDraft,
    selectedSkills: draft.includes(skillMarker) ? selectedSkills : emptySkills,
    setSelectedSkills,
    pluginMentions,
    pluginAnchors,
    setPluginMentions,
    attachments,
    sendingAttachments,
    setAttachments,
    queueMode,
    setQueueMode,
    promptPending,
    loadSnapshot,
    captureModeRevision: () => modes.current.revision,
    applyEvent,
    clearPromptPending,
    clearComposer,
    planDraft,
    setPlanDraft,
    captureComposer: () =>
      queueEdit.current?.restore ?? {
        selection: composerStore.getSnapshot().selection,
        draft,
        goalDraft,
        planDraft,
        selectedSkills,
        ...(pluginMentions.length ? { pluginMentions, pluginAnchors } : {}),
        attachments,
        queueMode,
        recoveredInputs,
        pendingConfiguration,
        editing:
          editingEntryId !== null && editRestore.current
            ? { entryId: editingEntryId, configuration: editConfiguration, restore: editRestore.current }
            : undefined,
      },
    restoreComposer: (value: ComposerSnapshot) => {
      composerStore.setSelection(value.selection ?? null)
      releaseQueueEdit()
      setGoalDraft(value.goalDraft)
      setPlanDraft(value.planDraft ?? '')
      setGoalOpen(false)
      setGoalEditing(false)
      composerStore.patch({
        draft: value.draft,
        selectedSkills: value.selectedSkills,
        pluginMentions: value.pluginMentions ?? [],
        pluginAnchors: value.pluginAnchors ?? {},
        attachments: value.attachments,
        queueMode: value.queueMode,
      })
      setRecoveredInputs(value.recoveredInputs ?? [])
      setPendingConfiguration(value.pendingConfiguration)
      setEditConfiguration(value.editing?.configuration)
      setEditingEntryId(value.editing?.entryId ?? null)
      editRestore.current = value.editing?.restore ?? null
    },
    reset,
    send,
    submitComposer: requestSubmit,
    submitVisualization: (text: string, context: VisualizationMessageContext) =>
      requestSubmit(undefined, text, true, structuredClone(context)),
    submitPlan: (plan: PlanAction, text?: string) => requestSubmit(plan, text),
    stop,
    resume,
    resumeQueue: () => queueAction('resume'),
    selectedConfiguration,
    pendingConfiguration,
    editConfiguration,
    updateConfiguration,
    configurationChanged,
    editSubmitting,
    recover,
    recovering:
      recoveryRequest !== null &&
      recoveryRequest.key === options.currentSessionKey() &&
      recoveryRequest.generation === options.currentGeneration(),
    steerQueueInput: (id: string) => queueAction('steerQueueInput', id),
    deleteQueueInput: (id: string) => queueAction('deleteQueueInput', id),
    editQueueInput,
    editingQueue,
    savingQueue,
    clearQueue,
    editing: editingEntryId !== null,
    editingEntryId,
    editMessage,
    cancelEdit,
  }
}
