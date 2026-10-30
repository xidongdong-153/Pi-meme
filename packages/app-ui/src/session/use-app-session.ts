import type { PlanDocument, PlanState } from '@pi-meme/contracts/plan'
import { activePathIds } from '@pi-meme/contracts/session-tree'
import type { SelectWorkspace } from '@pi-meme/contracts/sessions'
import { transferDraft } from '@pi-meme/chat/ui/composer/transfer-draft'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DesktopBridge,
  Connection,
  Snapshot,
  SessionSelectionResult,
  WorkspaceDeletionResult,
  DesktopEvent,
  DesktopError,
} from '@pi-meme/contracts/desktop'
import type { PiModel, PiSessionStats, PiSlashCommand, PiState, ThinkingLevel } from '@pi-meme/contracts/pi'
import { resolveThinkingLevel } from '@pi-meme/contracts/pi'
import { applyEvent as reduceEvent, emptyChat, fromSnapshot } from '@pi-meme/chat/ui/model/state'
import type { ChatState } from '@pi-meme/chat/ui/model/types'
import { useChatSession, type ComposerSnapshot } from '@pi-meme/chat/ui/use-chat-session'
import { useExtensionUI } from '@pi-meme/interaction/ui/use-extension-ui'
import { useSessions } from '@pi-meme/workspace/ui/use-sessions'
import { SessionSelection, type SelectionTransaction } from './session-selection'
import { SessionStreamEvents } from './stream-events'
import { SnapshotSync } from './snapshot-sync'
import { PluginSnapshotSync } from './plugin-snapshot-sync'
import { ComposerDrafts } from './composer-drafts'

function modelIsAvailable(models: PiModel[], model?: PiModel) {
  return Boolean(model && models.some((entry) => entry.provider === model.provider && entry.id === model.id))
}

/** 主对话事件订阅；选择事务和快照读取分别隔离过期结果，子代理对话独立订阅。 */
export function useAppSession(
  bridge: DesktopBridge,
  {
    chatEnabled = true,
    workspaceEnabled = true,
    hostId = '',
    host,
    onPlanSaved,
    persistDrafts = true,
    foreground = true,
  }: {
    chatEnabled?: boolean
    workspaceEnabled?: boolean
    hostId?: string
    host?: import('@pi-meme/contracts/app-host').HostApi
    onPlanSaved?: (document: PlanDocument, sessionKey: string | undefined) => void
    persistDrafts?: boolean
    foreground?: boolean
  } = {},
) {
  const foregroundRef = useRef(foreground)
  foregroundRef.current = foreground
  const onPlanSavedRef = useRef(onPlanSaved)
  onPlanSavedRef.current = onPlanSaved
  const [connection, setConnection] = useState<Connection>({ generation: 0, cwd: '', status: 'connecting' })
  const [hasConnected, setHasConnected] = useState(false)
  const [state, setState] = useState<PiState | null>(null)
  const [models, setModels] = useState<PiModel[]>([])
  const [thinkingLevels, setThinkingLevels] = useState<ThinkingLevel[]>([])
  const [sessionStats, setSessionStats] = useState<PiSessionStats | null>(null)
  const statsRequest = useRef(0)
  const [commands, setCommands] = useState<PiSlashCommand[]>([])
  const [uiPlugins, setUiPlugins] = useState<Snapshot['uiPlugins']>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [workspaceNotice, setWorkspaceNotice] = useState('')
  const [extensionError, setExtensionError] = useState<DesktopError>()
  const dismissedExtensionError = useRef<DesktopError | undefined>(undefined)
  const [acting, setActing] = useState(false)
  const [modelSaving, setModelSaving] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [appSession, setAppSession] = useState<Snapshot['appSession']>()
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyRevision, setHistoryRevision] = useState<string>()
  const historyRequest = useRef(0)
  const historyPending = useRef<number | undefined>(undefined)
  const commandRequest = useRef(0)
  const [failedSwitchPath, setFailedSwitchPath] = useState<string>()
  const detailsReads = useRef(new Map<string, Promise<void>>())
  const [switchingToPath, setSwitchingToPath] = useState<string>()
  const [forking, setForking] = useState(false)
  const [forkNotice, setForkNotice] = useState<{ sourcePath: string } | null>(null)
  const forkNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const currentRootAgentId = useRef<string | undefined>(undefined)
  const currentAgentTree = useRef<import('@pi-meme/contracts/collaboration').AgentSummary[]>([])
  const [planState, setPlanState] = useState<PlanState>()
  const [planDocuments, setPlanDocuments] = useState<PlanDocument[]>([])
  const current = useRef(connection)
  const displayed = useRef(connection)
  const mounted = useRef(false)
  const actionLock = useRef(false)
  const modelSelection = useRef<Promise<boolean> | null>(null)
  const modelSaveError = useRef<unknown>(undefined)
  const thinkingSelection = useRef<Promise<void> | null>(null)
  const thinkingSaveError = useRef<unknown>(undefined)
  const thinkingRequest = useRef(0)
  const selection = useRef(new SessionSelection())
  const preview = useRef<{ transaction: SelectionTransaction; draftKey: string; input?: SelectWorkspace } | null>(null)
  const pendingSwitch = useRef<{ target: string; promise: Promise<boolean> } | null>(null)
  const pendingCreations = useRef(
    new Map<string, { promise: Promise<boolean>; transaction: SelectionTransaction | null }>(),
  )
  const failedCreationDrafts = useRef(new Map<string, string>())
  const synchronization = useRef(new SnapshotSync())
  const pluginSynchronization = useRef(new PluginSnapshotSync())
  const streamEvents = useRef<SessionStreamEvents | null>(null)
  const views = useRef(new Map<string, { snapshot: Snapshot; chat: ChatState; sequence: number }>())
  const synced = useRef<{ generation: number; sessionKey?: string; status?: string } | undefined>(undefined)
  const drafts = useMemo(() => {
    if (persistDrafts) return new ComposerDrafts(hostId)
    return new ComposerDrafts(
      hostId,
      () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }),
      'temporary',
    )
  }, [hostId, persistDrafts])
  const chatRef = useRef<ReturnType<typeof useChatSession> | null>(null)
  const extensionsRef = useRef<ReturnType<typeof useExtensionUI> | null>(null)
  const { sessions, sessionsLoading, refreshSessions, setActiveSession } = useSessions(bridge, workspaceEnabled)
  const snapshotWindow = useCallback((key?: string) => {
    const messages = key ? views.current.get(key)?.chat.messages : undefined
    return { limit: 60, from: messages?.[0]?.sourceEntry?.id, details: 'deferred' as const }
  }, [])

  const commitSnapshot = useCallback(
    (snapshot: Snapshot, events: DesktopEvent[] | null, pluginRevision: number, modeRevision?: number) => {
      streamEvents.current?.flush()
      const retained = snapshot.connection.sessionKey && views.current.get(snapshot.connection.sessionKey)
      if (
        retained &&
        snapshot.historyDetails === 'deferred' &&
        retained.snapshot.historyDetails === 'complete' &&
        snapshot.historyRevision &&
        snapshot.historyRevision === retained.snapshot.historyRevision
      ) {
        snapshot = {
          ...snapshot,
          historyDetails: 'complete',
          sessionEntries: retained.snapshot.sessionEntries,
          branchAttachments: retained.snapshot.branchAttachments,
        }
      }
      setHistoryRevision(snapshot.historyRevision)
      const previousKey = displayed.current.sessionKey
      const previousGeneration = displayed.current.generation
      if (previousKey !== snapshot.connection.sessionKey) {
        modelSelection.current = null
        thinkingSelection.current = null
        thinkingSaveError.current = undefined
      }
      currentRootAgentId.current = snapshot.agent?.rootAgentId ?? snapshot.agent?.agentId
      currentAgentTree.current = snapshot.agents ?? []
      setPlanDocuments(
        snapshot.planState?.document ? [snapshot.planState.document] : (snapshot.planDocuments ?? []).slice(-1),
      )
      setPlanState(snapshot.planState)
      displayed.current = snapshot.connection
      current.current = snapshot.connection
      setConnection(snapshot.connection)
      setAppSession(snapshot.appSession)
      const diagnostic = snapshot.extensionError
      const dismissed = dismissedExtensionError.current
      if (
        !diagnostic ||
        diagnostic.sessionKey !== dismissed?.sessionKey ||
        diagnostic.generation !== dismissed?.generation ||
        diagnostic.message !== dismissed?.message
      )
        setExtensionError(diagnostic)
      const next = chatRef.current?.loadSnapshot(snapshot, events, modeRevision)
      if (next?.planState) {
        setPlanState(next.planState)
        setPlanDocuments(next.planState.document ? [next.planState.document] : [])
      }
      // 权威快照空闲时清除发送挂起标记，避免下一条消息被当成插话/排队。
      if (!snapshot.state.isStreaming && !snapshot.state.isCompacting) chatRef.current?.clearPromptPending()
      const key = snapshot.connection.sessionKey
      if (key && next) {
        views.current.delete(key)
        views.current.set(key, {
          snapshot,
          chat: next,
          sequence: Math.max(
            snapshot.eventSequence ?? 0,
            ...(events ?? []).filter((record) => record.sessionKey === key).map((record) => record.sequence ?? 0),
          ),
        })
        if (views.current.size > 20) views.current.delete(views.current.keys().next().value!)
      }
      if (previousKey !== key || previousGeneration !== snapshot.connection.generation) extensionsRef.current?.reset()
      extensionsRef.current?.restoreInteractions(snapshot.pendingInteractions ?? [])
      synced.current = {
        generation: snapshot.connection.generation,
        sessionKey: snapshot.connection.sessionKey,
        status: snapshot.connection.status,
      }
      setState(snapshot.state)
      if (pluginSynchronization.current.commit(pluginRevision, snapshot, current.current.sessionKey))
        setUiPlugins(snapshot.uiPlugins)
      setModels(snapshot.models)
      setThinkingLevels(snapshot.thinkingLevels ?? [])
      statsRequest.current++
      setSessionStats(snapshot.stats ?? null)
      setHasConnected(true)
      setLoading(false)
      setActiveSession(snapshot.connection.sessionFile ?? key, key)
      for (const record of [
        ...(snapshot.events ?? []),
        ...(events ?? []).filter(
          (value) =>
            value.sequence === undefined ||
            snapshot.eventSequence === undefined ||
            value.sequence > snapshot.eventSequence,
        ),
      ]) {
        if (record.sessionKey !== key || record.generation !== snapshot.connection.generation) continue
        if (
          snapshot.agent &&
          record.executionGeneration !== undefined &&
          record.executionGeneration !== snapshot.agent.executionGeneration
        )
          continue
        if (
          record.event.type === 'extension_ui_request' ||
          record.event.type === 'extension_ui_timeout' ||
          record.event.type === 'extension_ui_closed'
        )
          extensionsRef.current?.handleEvent(record.event, {
            sessionKey: record.sessionKey ?? key ?? '',
            executionGeneration: record.executionGeneration ?? 0,
            source: {
              agentId: record.agentId ?? snapshot.agent?.agentId ?? '',
              name: snapshot.agent?.name ?? '当前 Agent',
              rootSessionKey: key ?? '',
            },
          })
      }
    },
    [setActiveSession],
  )

  const refresh = useCallback(async () => {
    if (selection.current.current || preview.current) return
    const modeRevision = chatRef.current?.captureModeRevision()
    const read = synchronization.current.begin(current.current)
    const pluginRevision = pluginSynchronization.current.begin()
    const request = ++commandRequest.current
    const ownsCommands = () =>
      mounted.current &&
      !selection.current.current &&
      !preview.current &&
      request === commandRequest.current &&
      read.connection.sessionKey === current.current.sessionKey &&
      read.connection.generation === current.current.generation
    if (chatEnabled)
      void bridge.getCommands().then(
        (next) => {
          if (ownsCommands()) setCommands(next)
        },
        (cause) => {
          if (ownsCommands()) setError(`无法读取会话命令：${String(cause)}`)
        },
      )
    try {
      const snapshot = await bridge.getSnapshot(snapshotWindow(read.connection.sessionKey))
      if (
        !mounted.current ||
        !synchronization.current.owns(read, current.current) ||
        snapshot.connection.generation !== current.current.generation ||
        snapshot.connection.sessionKey !== current.current.sessionKey
      )
        return
      commitSnapshot(snapshot, read.events, pluginRevision, modeRevision)
    } catch (cause) {
      // 读取失败时清掉已提交标记，下一次 ready/idle 连接事件可以重试。
      synced.current = undefined
      if (mounted.current && synchronization.current.owns(read, current.current)) {
        setError(String(cause))
        setLoading(false)
      }
    } finally {
      synchronization.current.finish(read)
    }
  }, [bridge, chatEnabled, commitSnapshot, snapshotWindow])

  const refreshUiPlugins = useCallback(async () => {
    const connection = current.current
    const pluginRevision = pluginSynchronization.current.begin()
    let snapshot: Snapshot
    try {
      snapshot = await bridge.getSnapshot(snapshotWindow(connection.sessionKey))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // 删除当前会话时，插件变更会按旧会话再读一次快照。这次作废，不能冒泡成「无法读取插件列表」。
      if (
        !mounted.current ||
        connection.sessionKey !== current.current.sessionKey ||
        message.includes('当前查看的会话已更换')
      )
        return
      throw cause
    }
    if (
      mounted.current &&
      !selection.current.current &&
      connection.sessionKey === current.current.sessionKey &&
      snapshot.connection.sessionKey === current.current.sessionKey &&
      snapshot.connection.generation >= current.current.generation &&
      pluginSynchronization.current.commit(pluginRevision, snapshot, current.current.sessionKey)
    )
      setUiPlugins(snapshot.uiPlugins)
  }, [bridge, snapshotWindow])

  const loadOlderMessages = async () => {
    const expected = current.current
    const before = chatRef.current?.captureChat().messagePage?.before
    if (
      !expected.sessionKey ||
      !before ||
      historyPending.current !== undefined ||
      selection.current.current ||
      preview.current
    )
      return false
    const request = ++historyRequest.current
    historyPending.current = request
    setHistoryError('')
    setHistoryLoading(true)
    const owns = () =>
      mounted.current &&
      request === historyRequest.current &&
      expected.sessionKey === current.current.sessionKey &&
      expected.generation === current.current.generation &&
      !selection.current.current &&
      !preview.current
    try {
      const history = await bridge.readSessionHistory(expected.sessionKey, { limit: 60, before, details: 'deferred' })
      const cached = views.current.get(expected.sessionKey)
      const latest = chatRef.current?.captureChat()
      if (!owns() || !cached || !latest || latest.messagePage?.before !== before) return false
      const messages = [...history.messages, ...latest.messages]
      const snapshot = { ...cached.snapshot, messages, messagePage: history.messagePage }
      const restored = fromSnapshot(snapshot)
      const next = {
        ...latest,
        messages,
        messagePage: history.messagePage,
        tools: { ...restored.tools, ...latest.tools },
      }
      cached.snapshot = snapshot
      cached.chat = next
      chatRef.current?.restoreChat(next)
      return true
    } catch (cause) {
      if (owns()) setHistoryError(`无法加载更早记录：${cause instanceof Error ? cause.message : String(cause)}`)
      return false
    } finally {
      if (historyPending.current === request) historyPending.current = undefined
      if (mounted.current && request === historyRequest.current) setHistoryLoading(false)
    }
  }

  const chatBridge = useMemo(() => {
    function afterModelSelection<Args extends unknown[], Result>(send: (...args: Args) => Promise<Result>) {
      return async (...args: Args) => {
        const pending = modelSelection.current
        if (pending && !(await pending)) throw modelSaveError.current ?? new Error('模型切换失败，消息尚未发送')
        await thinkingSelection.current
        if (thinkingSaveError.current) throw thinkingSaveError.current
        return send.apply(bridge, args)
      }
    }
    return {
      ...bridge,
      prompt: afterModelSelection(bridge.prompt),
      followUp: afterModelSelection(bridge.followUp),
      editAndPrompt: async (...args: Parameters<DesktopBridge['editAndPrompt']>) => {
        await Promise.allSettled([modelSelection.current, thinkingSelection.current])
        return bridge.editAndPrompt(...args)
      },
    }
  }, [bridge])
  const chat = useChatSession({
    submitPlan: host
      ? async (sessionKey, text, options, idempotencyKey) => {
          const pending = modelSelection.current
          if (pending && !(await pending)) throw modelSaveError.current ?? new Error('模型切换失败，计划尚未发送')
          await thinkingSelection.current
          if (thinkingSaveError.current) throw thinkingSaveError.current
          const session = await bridge.resolveAppSession(sessionKey)
          const receipt = await host.sessions.submit(
            { hostId: session.hostId, sessionId: session.sessionId },
            { delivery: 'start', text, ...options },
            { idempotencyKey },
          )
          if (receipt.status === 'failed' || receipt.status === 'cancelled')
            throw new Error(receipt.error ?? '计划提交失败')
        }
      : undefined,
    bridge: chatBridge,
    configuration: () => ({ model: state?.model, thinkingLevel: state?.thinkingLevel }),
    refresh,
    commands,
    canSend: () =>
      !loading &&
      !acting &&
      !switching &&
      !preview.current &&
      !current.current.accessChanging &&
      (current.current.status === 'ready' || current.current.status === 'idle') &&
      (!state?.modelSelectionRequired ||
        modelIsAvailable(models, (chatRef.current?.editConfiguration ?? chatRef.current?.pendingConfiguration)?.model)),
    isSwitching: () => selection.current.current !== null,
    awaitPendingSwitch: async () => {
      await selection.current.pending
    },
    currentGeneration: () => current.current.generation,
    currentSessionKey: () => (selection.current.current || preview.current ? undefined : current.current.sessionKey),
    onError: setError,
    onBackgroundEdit: (key, composer) => {
      drafts.set(key, composer)
      if (key === current.current.sessionKey && !selection.current.current) {
        chatRef.current?.restoreComposer(composer)
        void refresh()
      }
    },
    onSendStarted: (key, composer) => drafts.startSend(key, composer),
    onSendFailed: (key, composer) => {
      if (!key || key === current.current.sessionKey) void refresh()
      else {
        const saved = drafts.get(key)
        drafts.set(key, saved && (saved.draft || saved.pluginMentions?.length) ? saved : composer)
      }
    },
  })
  chatRef.current = chat
  const draftModel = (chat.editConfiguration ?? chat.pendingConfiguration)?.model
  useEffect(() => {
    const model = state?.model
    if (loading || switching || previewing || !model || !draftModel) return
    if (modelIsAvailable(models, model) && !modelIsAvailable(models, draftModel))
      chatRef.current?.updateConfiguration({ model, thinkingLevel: state?.thinkingLevel })
  }, [loading, switching, previewing, state?.model, state?.thinkingLevel, models, draftModel, chat.editSubmitting])
  const bindDraftSession = useCallback(
    (key: string, sessionId: string) => {
      const saved = drafts.bind(key, sessionId)
      if (saved && key === current.current.sessionKey && !selection.current.current)
        chatRef.current?.restoreComposer(saved)
    },
    [drafts],
  )
  useEffect(() => {
    const key = preview.current?.draftKey ?? connection.sessionKey
    if (key && (!switching || preview.current)) drafts.set(key, chat.captureComposer())
  }, [
    drafts,
    connection.sessionKey,
    switching,
    chat.draft,
    chat.goalDraft,
    chat.planDraft,
    chat.selectedSkills,
    chat.pluginMentions,
    chat.pluginAnchors,
    chat.attachments,
    chat.queueMode,
    chat.editingEntryId,
    chat.pendingConfiguration,
    chat.editConfiguration,
    chat.recoveredInputs,
    chat.editingQueue,
  ])
  const extensions = useExtensionUI(bridge, chat.setDraft, () => current.current.sessionKey)
  extensionsRef.current = extensions

  useEffect(() => {
    mounted.current = true
    const refreshStats = async () => {
      const connection = current.current
      const request = ++statsRequest.current
      const owns = () =>
        mounted.current &&
        !selection.current.current &&
        request === statsRequest.current &&
        connection.generation === current.current.generation &&
        connection.sessionKey === current.current.sessionKey
      try {
        const stats = await bridge.getSessionStats()
        if (owns()) setSessionStats(stats)
      } catch (cause) {
        if (owns()) setError(`无法读取上下文用量：${String(cause)}`)
      }
    }
    const updateConnection = (next: Connection) => {
      if (!mounted.current || next.generation < current.current.generation) return
      const previous = current.current
      current.current = next
      if (selection.current.current || preview.current) return
      setConnection(next)
      setActiveSession(next.sessionFile ?? next.sessionKey, next.sessionKey)
      if (next.error) setError(next.error)
      else if (
        (next.status === 'ready' && previous.status !== 'ready') ||
        (next.status === 'idle' && (previous.status === 'disconnected' || previous.status === 'connecting'))
      )
        setError('')
      if (selection.current.current) return
      if (next.generation !== previous.generation || next.sessionKey !== previous.sessionKey) {
        synchronization.current.cancel()
        if (previous.sessionKey && chatRef.current) drafts.set(previous.sessionKey, chatRef.current.captureComposer())
        if (next.sessionKey !== previous.sessionKey) {
          currentRootAgentId.current = undefined
          currentAgentTree.current = []
          setPlanDocuments([])
          setPlanState(undefined)
          setForkNotice(null)
          const cached = next.sessionKey && views.current.get(next.sessionKey)
          if (cached) chatRef.current?.restoreChat(cached.chat)
          else chatRef.current?.reset()
          const draft = next.sessionKey && drafts.get(next.sessionKey)
          if (draft) chatRef.current?.restoreComposer(draft)
          else chatRef.current?.clearComposer()
        }
        // 会话或代次变化时旧 Worker 的扩展状态和命令都不再可信。
        extensionsRef.current?.reset()
        setCommands([])
        setExtensionError(undefined)
        dismissedExtensionError.current = undefined
        setError(next.error ?? '')
      }
      const syncedConnection = synced.current
      if (
        (next.status === 'ready' || next.status === 'idle') &&
        (previous.status !== next.status ||
          next.generation !== previous.generation ||
          next.sessionKey !== previous.sessionKey ||
          !syncedConnection ||
          syncedConnection.generation !== next.generation ||
          syncedConnection.sessionKey !== next.sessionKey)
      )
        void refresh()
    }
    const offConnection = bridge.onConnection(updateConnection)
    const offError = bridge.onError((value) => {
      if (
        mounted.current &&
        value.sessionKey === current.current.sessionKey &&
        value.generation >= current.current.generation
      ) {
        if (value.extension) setExtensionError(value)
        else setError(value.message)
      }
    })
    const receiveEvent = (record: DesktopEvent) => {
      if (!mounted.current) return
      const event = record.event
      const extension =
        event.type === 'extension_ui_request' ||
        event.type === 'extension_ui_timeout' ||
        event.type === 'extension_ui_closed'
      const cached = record.sessionKey && views.current.get(record.sessionKey)
      if (cached && record.sequence !== undefined && record.sequence <= cached.sequence) return
      const visible =
        record.sessionKey === current.current.sessionKey &&
        record.generation === current.current.generation &&
        !selection.current.current &&
        !preview.current
      const applyCurrent = (event: Parameters<typeof reduceEvent>[1]) => {
        chatRef.current?.applyEvent(event)
        if (cached && chatRef.current) cached.chat = chatRef.current.captureChat()
      }
      if (cached && !extension && !visible) {
        cached.chat = reduceEvent(cached.chat, event)
      }
      if (cached) cached.sequence = record.sequence ?? cached.sequence
      if (selection.current.current || preview.current) return
      if (event.type === 'access_mode_changed') {
        if (record.sessionKey === current.current.sessionKey && record.generation === current.current.generation) {
          current.current = { ...current.current, accessMode: event.mode }
          setConnection(current.current)
        }
        return
      }
      if (extension) {
        const source = record.agentId && currentAgentTree.current.find((agent) => agent.agentId === record.agentId)
        const dialogEvent =
          event.type !== 'extension_ui_request' ||
          ['select', 'confirm', 'input', 'editor', 'questions'].includes(event.method)
        const belongsToRoot = record.rootAgentId && record.rootAgentId === currentRootAgentId.current
        if (((source || belongsToRoot) && dialogEvent) || record.sessionKey === current.current.sessionKey) {
          extensionsRef.current?.handleEvent(event, {
            sessionKey: record.sessionKey ?? '',
            executionGeneration: record.executionGeneration ?? 0,
            source: source
              ? { agentId: source.agentId, name: source.name, rootSessionKey: source.rootSessionKey }
              : belongsToRoot && record.agentId && record.sessionKey !== current.current.sessionKey
                ? { agentId: record.agentId, name: '子代理', rootSessionKey: current.current.sessionKey ?? '' }
                : undefined,
          })
        }
        return
      }
      if (event.type === 'agents_update') {
        if (
          event.agents.some((agent) => agent.rootSessionKey === current.current.sessionKey) ||
          record.sessionKey === current.current.sessionKey
        ) {
          currentAgentTree.current = event.agents.filter((agent) => agent.rootSessionKey === current.current.sessionKey)
          applyCurrent({ ...event, agents: currentAgentTree.current })
        }
        return
      }
      if (event.type === 'agent_mailbox') {
        if (
          record.sessionKey === current.current.sessionKey ||
          currentAgentTree.current.some((agent) => agent.rootTaskId === event.message.rootTaskId)
        )
          applyCurrent(event)
        return
      }
      if (event.type === 'plan_state_changed') {
        if (
          selection.current.current ||
          record.generation !== current.current.generation ||
          record.sessionKey !== current.current.sessionKey
        )
          return
        const known = chatRef.current?.captureChat().planState
        if (known && known.revision >= event.state.revision) return
        setPlanState(event.state)
        setPlanDocuments(event.state.document ? [event.state.document] : [])
        applyCurrent(event)
        if (event.reason === 'saved' && event.state.document)
          onPlanSavedRef.current?.(event.state.document, record.sessionKey)
        return
      }
      if (event.type === 'plan_saved') {
        if (
          selection.current.current ||
          record.generation !== current.current.generation ||
          record.sessionKey !== current.current.sessionKey
        )
          return
        if (chatRef.current?.captureChat().planState) return
        const known = chatRef.current?.captureChat().planDocuments?.find((doc) => doc.id === event.document.id)
        if (known && known.revision >= event.document.revision) return
        setPlanDocuments([event.document])
        applyCurrent(event)
        onPlanSavedRef.current?.(event.document, record.sessionKey)
        return
      }
      if (
        selection.current.current ||
        record.generation !== current.current.generation ||
        record.sessionKey !== current.current.sessionKey
      )
        return
      if (event.type === 'agent_settled') chatRef.current?.clearPromptPending()
      applyCurrent(event)
      if (event.type === 'message_end' && event.message.role === 'assistant') void refreshStats()
      if (event.type === 'agent_settled' || event.type === 'compaction_end') {
        setRefreshToken((value) => value + 1)
        void refresh()
      }
    }
    const queue = new SessionStreamEvents(
      receiveEvent,
      (key) => foregroundRef.current && key === current.current.sessionKey,
      (key) => Boolean((key && views.current.has(key)) || selection.current.current),
    )
    streamEvents.current = queue
    const offEvent = bridge.onEvent((record) => {
      selection.current.current?.events.push(record)
      synchronization.current.receive(record)
      queue.push(record)
    })
    void bridge
      .getConnection()
      .then(updateConnection)
      .catch((cause) => {
        if (mounted.current) {
          setError(String(cause))
          setLoading(false)
        }
      })
    return () => {
      mounted.current = false
      if (forkNoticeTimer.current) clearTimeout(forkNoticeTimer.current)
      selection.current.cancel()
      synchronization.current.cancel()
      offConnection()
      offError()
      offEvent()
      queue.dispose()
      if (streamEvents.current === queue) streamEvents.current = null
    }
  }, [bridge, drafts, refresh, setActiveSession])

  useEffect(() => {
    if (!sessions) return
    const visible = new Set(
      [...sessions.projects.flatMap((project) => project.sessions), ...(sessions.standaloneSessions ?? [])].map(
        (session) => session.id,
      ),
    )
    for (const [key, view] of views.current) {
      if (key !== current.current.sessionKey && !visible.has(key) && !view.chat.running && !view.chat.messages.length) {
        views.current.delete(key)
        drafts.delete(key)
      }
    }
  }, [drafts, sessions])

  const action = useCallback(async (work: (key: string, owns: () => boolean) => Promise<void>, blocking = true) => {
    const key = current.current.sessionKey
    const generation = current.current.generation
    const owns = () =>
      mounted.current && key === current.current.sessionKey && generation === current.current.generation
    if (!key || actionLock.current || selection.current.current || preview.current) return false
    actionLock.current = true
    synchronization.current.cancel()
    historyRequest.current++
    historyPending.current = undefined
    setHistoryLoading(false)
    setHistoryError('')
    commandRequest.current++
    if (blocking) setActing(true)
    setError('')
    try {
      await work(key, owns)
      return true
    } catch (cause) {
      if (owns()) setError(String(cause))
      return false
    } finally {
      actionLock.current = false
      if (blocking && mounted.current) setActing(false)
    }
  }, [])

  const select = async (
    work: () => Promise<SessionSelectionResult>,
    target?: string,
    carryDraft = false,
    refreshCommands = true,
    replaceable = false,
    previewInput?: SelectWorkspace,
  ) => {
    if (
      actionLock.current ||
      current.current.accessChanging ||
      chatRef.current?.editSubmitting ||
      selection.current.current?.replaceable === false
    )
      return false
    let succeeded = false
    const replacing = selection.current.current !== null
    const transaction = selection.current.begin(target, replaceable)
    const pluginRevision = pluginSynchronization.current.begin()
    const modeRevision = chatRef.current?.captureModeRevision()
    const owns = () => mounted.current && selection.current.owns(transaction)
    let previousMode = chatRef.current?.mode
    const previous = displayed.current
    const previousPath = previous.sessionFile ?? previous.sessionKey
    const savedComposer = previous.sessionKey && drafts.get(previous.sessionKey)
    const sourcePreview = preview.current
    if (preview.current && chatRef.current) drafts.set(preview.current.draftKey, chatRef.current.captureComposer())
    let previousComposer =
      (replacing || preview.current) && savedComposer && !savedComposer.editing
        ? savedComposer
        : chatRef.current?.captureComposer()
    streamEvents.current?.flush()
    const previousView = previous.sessionKey && views.current.get(previous.sessionKey)
    if (previous.sessionKey && previousComposer) drafts.set(previous.sessionKey, previousComposer)
    if (!replacing && !preview.current && previousView && chatRef.current)
      previousView.chat = chatRef.current.captureChat()
    preview.current = null
    setPreviewing(false)
    synchronization.current.cancel()
    historyRequest.current++
    historyPending.current = undefined
    setHistoryLoading(false)
    setHistoryError('')
    commandRequest.current++
    setSwitching(true)
    setFailedSwitchPath(undefined)
    setSwitchingToPath(target)
    setLoading(false)
    setError('')
    if (target) setActiveSession(target)
    chatRef.current?.clearPromptPending()
    let previewDraftKey: string | undefined
    const showPreview = () => {
      const cached = target
        ? [...views.current.values()].find(
            (view) => view.snapshot.connection.sessionKey === target || view.snapshot.connection.sessionFile === target,
          )
        : undefined
      if (!cached && !previewInput) {
        const summary = [
          ...(sessions?.projects.flatMap((project) => project.sessions) ?? []),
          ...(sessions?.standaloneSessions ?? []),
          ...(sessions?.recents ?? []),
        ].find((session) => session.path === target || session.id === target)
        if (summary) {
          setConnection({
            ...previous,
            sessionKey: undefined,
            sessionFile: summary.path,
            cwd: summary.cwd,
            workspaceKind: summary.workspaceKind,
            sourceProjectCwd: summary.sourceProjectCwd,
          })
          setState((value) => value && { ...value, sessionName: summary.name })
          setAppSession(undefined)
        }
        return
      }
      const draftKey = cached?.snapshot.connection.sessionKey ?? `draft:${transaction.id}`
      previewDraftKey = draftKey
      preview.current = { transaction, draftKey, input: previewInput }
      const nextState: PiState = cached?.snapshot.state ?? {
        mode: 'default',
        model: state?.model,
        isStreaming: false,
        isCompacting: false,
        steeringMode: 'one-at-a-time',
        followUpMode: 'all',
        pendingMessageCount: 0,
      }
      const next: Snapshot = cached?.snapshot ?? {
        connection: {
          ...previous,
          sessionKey: undefined,
          sessionFile: undefined,
          sourceProjectCwd: undefined,
          cwd: previewInput?.kind === 'project' ? previewInput.cwd : '',
          workspaceKind: previewInput?.kind,
          status: 'idle',
          error: undefined,
        },
        state: nextState,
        messages: [],
        models,
        thinkingLevels,
      }
      setConnection(next.connection)
      setAppSession(next.appSession)
      setState(nextState)
      setSessionStats(next.stats ?? null)
      setPlanState(cached?.chat.planState)
      setPlanDocuments(cached?.chat.planDocuments ?? [])
      setUiPlugins(next.uiPlugins)
      setCommands([])
      extensionsRef.current?.reset()
      chatRef.current?.loadSnapshot(next, null)
      chatRef.current?.restoreChat(cached?.chat ?? { ...emptyChat, goalsSupported: chat.chat.goalsSupported })
      const failedKey = previewInput && failedCreationDrafts.current.get(JSON.stringify(previewInput))
      const draft = carryDraft
        ? sourcePreview
          ? drafts.get(sourcePreview.draftKey)
          : previousComposer
        : drafts.get(failedKey || draftKey)
      if (draft) chatRef.current?.restoreComposer(draft)
      else chatRef.current?.clearComposer()
      setPreviewing(true)
      extensionsRef.current?.focusDraft()
    }
    const pending = (async () => {
      try {
        if (replaceable && chatRef.current?.editing) {
          await chatRef.current.cancelEdit()
          if (!owns()) return
          previousComposer = chatRef.current?.captureComposer()
          previousMode = chatRef.current?.mode
          if (previous.sessionKey && previousComposer) drafts.set(previous.sessionKey, previousComposer)
        }
        showPreview()
        const result = await work()
        if (!owns()) {
          if (previewInput && previewDraftKey && !result.cancelled && result.snapshot.connection.sessionKey) {
            const draft = drafts.get(previewDraftKey)
            if (draft) drafts.set(result.snapshot.connection.sessionKey, draft)
            if (result.snapshot.appSession)
              drafts.bind(result.snapshot.connection.sessionKey, result.snapshot.appSession.sessionId)
            drafts.delete(previewDraftKey)
          }
          return
        }
        if (result.cancelled) {
          if (previewInput) {
            if (previewDraftKey) {
              if (chatRef.current) drafts.set(previewDraftKey, chatRef.current.captureComposer())
              failedCreationDrafts.current.set(JSON.stringify(previewInput), previewDraftKey)
            }
            setError('会话创建已取消，草稿已保留，请重试')
            return
          }
          const snapshot = await bridge.getSnapshot(snapshotWindow(current.current.sessionKey))
          if (!owns()) return
          preview.current = null
          commitSnapshot(snapshot, transaction.events, pluginRevision, modeRevision)
          if (previousComposer) chatRef.current?.restoreComposer(previousComposer)
          setActiveSession(previousPath, previous.sessionKey)
          return
        }
        let transferred: ReturnType<typeof transferDraft> | undefined
        if (carryDraft && previousComposer) {
          const nextCommands = result.commands ?? (await bridge.getCommands())
          if (!owns()) return
          transferred = transferDraft(
            previewInput ? (chatRef.current?.captureComposer() ?? previousComposer) : previousComposer,
            nextCommands,
          )
          setCommands(nextCommands)
        }
        const draft =
          transferred?.composer ??
          (previewInput && preview.current?.transaction === transaction
            ? chatRef.current?.captureComposer()
            : undefined) ??
          (result.snapshot.connection.sessionKey && drafts.get(result.snapshot.connection.sessionKey))
        preview.current = null
        commitSnapshot(result.snapshot, transaction.events, pluginRevision, modeRevision)
        if (draft) chatRef.current?.restoreComposer(draft)
        else chatRef.current?.clearComposer()
        if (previewInput && previewDraftKey) {
          drafts.delete(previewDraftKey)
          const identity = JSON.stringify(previewInput)
          const failedKey = failedCreationDrafts.current.get(identity)
          if (failedKey) drafts.delete(failedKey)
          failedCreationDrafts.current.delete(identity)
        }
        if (transferred) {
          if (previousMode) chatRef.current?.changeMode(previousMode)
          if (sourcePreview) {
            drafts.delete(sourcePreview.draftKey)
            if (sourcePreview.input) failedCreationDrafts.current.delete(JSON.stringify(sourcePreview.input))
          } else if (previous.sessionKey) drafts.delete(previous.sessionKey)
          setWorkspaceNotice(
            [
              transferred.removedSkills ? '部分技能在当前项目不可用，已转为文字' : '',
              /(?:^|\s)@/u.test(transferred.composer.draft) ? '文件引用将按当前目录解析' : '',
            ]
              .filter(Boolean)
              .join('；'),
          )
        } else setWorkspaceNotice('')
        succeeded = true
        extensionsRef.current?.focusDraft()
        setRefreshToken((value) => value + 1)
        const generation = result.snapshot.connection.generation
        if (!carryDraft && refreshCommands)
          void bridge
            .getCommands()
            .then((nextCommands) => {
              if (
                mounted.current &&
                !selection.current.current &&
                generation === current.current.generation &&
                result.snapshot.connection.sessionKey === current.current.sessionKey
              )
                setCommands(nextCommands)
            })
            .catch(() => {})
      } catch (cause) {
        if (!owns()) return
        if (previewInput && preview.current?.transaction === transaction) {
          if (chatRef.current) drafts.set(preview.current.draftKey, chatRef.current.captureComposer())
          failedCreationDrafts.current.set(JSON.stringify(previewInput), preview.current.draftKey)
          setError(String(cause))
          return
        }
        const missing = /ENOENT|会话不存在|运行中的会话不存在|只能打开应用内保存的会话/.test(String(cause))
        if (missing && target) {
          for (const [key, value] of views.current) {
            if (value.snapshot.connection.sessionKey === target || value.snapshot.connection.sessionFile === target)
              views.current.delete(key)
          }
        }
        if (!missing && !previewInput && preview.current?.transaction === transaction && target) {
          setFailedSwitchPath(target)
          setError(`会话同步失败：${String(cause)}`)
          return
        }
        preview.current = null
        try {
          if (current.current.sessionKey !== previous.sessionKey && previousPath) {
            const restored = await bridge.switchSession(previousPath)
            if (!owns()) return
            if (!restored.cancelled) commitSnapshot(restored.snapshot, transaction.events, pluginRevision, modeRevision)
          } else {
            const snapshot = await bridge.getSnapshot(snapshotWindow(current.current.sessionKey))
            if (!owns()) return
            commitSnapshot(snapshot, transaction.events, pluginRevision, modeRevision)
          }
          if (previousComposer) chatRef.current?.restoreComposer(previousComposer)
          setActiveSession(previousPath, previous.sessionKey)
        } catch {
          if (!owns()) return
          try {
            if (previousView && !previousView.chat.messages.length && !previousView.chat.running)
              await bridge.chooseDirectory(previous.cwd)
            const snapshot = await bridge.getSnapshot(snapshotWindow(current.current.sessionKey))
            if (!owns()) return
            if (previousComposer && previousView && !previousView.chat.messages.length)
              chatRef.current?.restoreComposer(previousComposer)
            commitSnapshot(snapshot, transaction.events, pluginRevision, modeRevision)
          } catch (restoreCause) {
            if (owns()) setError(`${String(cause)}；无法恢复会话：${String(restoreCause)}`)
            return
          }
        }
        if (owns()) setError(String(cause))
      } finally {
        if (owns()) {
          selection.current.finish(transaction)
          setSwitching(false)
          setPreviewing(Boolean(preview.current))
          setSwitchingToPath(undefined)
          void refreshSessions()
        }
      }
    })()
    selection.current.pending = pending
    await pending
    return succeeded
  }

  const createSession = (input: SelectWorkspace, carryDraft = false, refreshCommands = true) => {
    const identity = JSON.stringify([input, carryDraft, refreshCommands])
    const existing = pendingCreations.current.get(identity)
    if (existing && selection.current.current === existing.transaction) return existing.promise
    const pending = select(
      () =>
        (input.kind === 'project' && input.cwd === current.current.cwd) ||
        (input.kind === 'standalone' && current.current.workspaceKind === 'standalone')
          ? bridge.newSession()
          : bridge.selectWorkspace(input),
      undefined,
      carryDraft,
      refreshCommands,
      true,
      input,
    )
    const creation = { promise: pending, transaction: selection.current.current }
    pendingCreations.current.set(identity, creation)
    const release = () => {
      if (pendingCreations.current.get(identity) === creation) pendingCreations.current.delete(identity)
    }
    void pending.then(release, release)
    return pending
  }
  const switchSession = (sessionPath: string) => {
    if (selection.current.current?.target === sessionPath && pendingSwitch.current?.target === sessionPath)
      return pendingSwitch.current.promise
    if (
      !selection.current.current &&
      (sessionPath === current.current.sessionKey || sessionPath === current.current.sessionFile)
    )
      return Promise.resolve(true)
    const cached = [...views.current.values()].find(
      (view) =>
        view.snapshot.connection.sessionKey === sessionPath || view.snapshot.connection.sessionFile === sessionPath,
    )
    const promise = select(
      () => bridge.switchSession(sessionPath, snapshotWindow(cached?.snapshot.connection.sessionKey)),
      sessionPath,
      false,
      true,
      true,
    )
    pendingSwitch.current = { target: sessionPath, promise }
    const release = () => {
      if (pendingSwitch.current?.promise === promise) pendingSwitch.current = null
    }
    void promise.then(release, release)
    return promise
  }
  const selectWorkspace = (input: SelectWorkspace) => {
    if (chat.editing || actionLock.current || current.current.accessChanging) return Promise.resolve(false)
    if (
      !selection.current.current &&
      ((input.kind === 'standalone' && current.current.workspaceKind === 'standalone') ||
        (input.kind === 'project' && input.cwd === current.current.cwd))
    )
      return Promise.resolve(true)
    return select(() => bridge.selectWorkspace(input), undefined, true, true, true, input)
  }
  const chooseDirectory = async () => {
    if (chat.editing || actionLock.current || selection.current.current || current.current.accessChanging) return false
    try {
      const project = await bridge.addProjectDirectory()
      if (!project) return false
      return await selectWorkspace({ kind: 'project', cwd: project.cwd })
    } catch (cause) {
      setError(String(cause))
      return false
    }
  }
  const loadHistoryDetails = useCallback(async () => {
    if (selection.current.current || preview.current) return
    const key = current.current.sessionKey
    const cached = key && views.current.get(key)
    if (!key || !cached || cached.snapshot.historyDetails !== 'deferred') return
    const generation = current.current.generation
    const revision = cached.snapshot.historyRevision
    const requestId = `${key}:${generation}:${revision ?? ''}`
    const previous = detailsReads.current.get(requestId)
    if (previous) return previous
    const read = (async () => {
      try {
        const history = await bridge.getSnapshot()
        if (
          current.current.sessionKey !== key ||
          current.current.generation !== generation ||
          views.current.get(key) !== cached ||
          cached.snapshot.historyRevision !== revision ||
          (history.historyRevision && revision && history.historyRevision !== revision)
        )
          return
        cached.snapshot = {
          ...cached.snapshot,
          historyDetails: 'complete',
          sessionEntries: history.sessionEntries,
          branchAttachments: history.branchAttachments,
        }
        const next = {
          ...chatRef.current!.captureChat(),
          sessionEntries: history.sessionEntries,
          branchAttachments: history.branchAttachments ?? [],
        }
        cached.chat = next
        chatRef.current?.restoreChat(next)
      } catch (cause) {
        if (current.current.sessionKey === key && current.current.generation === generation) setError(String(cause))
      }
    })().finally(() => {
      if (detailsReads.current.get(requestId) === read) detailsReads.current.delete(requestId)
    })
    detailsReads.current.set(requestId, read)
    return read
  }, [bridge, connection.sessionKey, connection.generation, switching, previewing, historyRevision])
  const inputDisabled =
    chat.editSubmitting ||
    loading ||
    acting ||
    switching ||
    previewing ||
    (connection.status !== 'ready' && connection.status !== 'idle') ||
    Boolean(connection.accessChanging) ||
    (Boolean(state?.modelSelectionRequired) && !modelIsAvailable(models, draftModel))
  const modelPickerDisabled =
    chat.editSubmitting ||
    loading ||
    acting ||
    switching ||
    previewing ||
    (connection.status !== 'ready' && connection.status !== 'idle') ||
    Boolean(connection.accessChanging)
  const supportedCommands = useMemo(
    () =>
      commands.filter((command) => command.name !== 'goal' || command.source !== 'builtin' || chat.chat.goalsSupported),
    [commands, chat.chat.goalsSupported],
  )

  let visiblePlanState = planState
  if (chat.editingEntryId) {
    const entries = chat.chat.sessionEntries?.entries ?? []
    const target = entries.find((entry) => entry.id === chat.editingEntryId)
    const retained = activePathIds(entries, target?.parentId ?? null)
    const checkpoints = new Map(chat.chat.planCheckpoints?.map((item) => [item.sourceEntryId, item]))
    const checkpoint = [...retained].map((id) => checkpoints.get(id)).find((item) => item !== undefined)
    visiblePlanState = planState
      ? {
          ...planState,
          document: checkpoint
            ? { ...checkpoint.document, id: planState.document?.id ?? checkpoint.document.id }
            : undefined,
          sourceEntryId: checkpoint?.sourceEntryId,
        }
      : undefined
  }
  const visiblePlanDocuments =
    chat.editingEntryId || planState ? (visiblePlanState?.document ? [visiblePlanState.document] : []) : planDocuments
  return {
    bindDraftSession,
    hasUnstoredDraft: drafts.hasUnstoredInput,
    hasDraftInput: drafts.hasInput,
    captureDraft: () => ({ composer: chat.captureComposer(), mode: chat.mode }),
    clearDraft: () => {
      chat.clearComposer()
      if (current.current.sessionKey) drafts.delete(current.current.sessionKey)
    },
    selectLocation: async (
      input: SelectWorkspace,
      incoming?: { composer: ComposerSnapshot; mode: import('@pi-meme/contracts/plan').TaskMode },
    ) => {
      const changed = await createSession(input, !incoming, !incoming)
      if (changed && incoming) {
        const expected = { ...current.current }
        const commands = await bridge.getCommands().catch(() => [] as PiSlashCommand[])
        if (
          expected.sessionKey !== current.current.sessionKey ||
          expected.generation !== current.current.generation ||
          selection.current.current
        )
          return false
        const transferred = transferDraft(incoming.composer, commands)
        chat.restoreComposer(transferred.composer)
        chat.changeMode(incoming.mode)
        setCommands(commands)
        setWorkspaceNotice(transferred.removedSkills ? '部分技能在当前服务不可用，已转为文字' : '')
      }
      return changed
    },
    switchGitBranch: (branch: string) =>
      select(() => bridge.switchGitBranch(current.current.sessionKey!, branch), undefined, true),
    createGitBranch: (name: string, base: string) =>
      select(() => bridge.createGitBranch(current.current.sessionKey!, name, base), undefined, true),
    createGitWorktree: (base: string) =>
      select(
        async () => {
          const result = await bridge.createGitWorktree(current.current.sessionKey!, base)
          if (result.selectionError) throw new Error(`Worktree 已创建：${result.cwd}；${result.selectionError}`)
          return result.selection
        },
        undefined,
        true,
      ),
    planDocuments: visiblePlanDocuments,
    planState: visiblePlanState,
    planDraft: chat.planDraft,
    setPlanDraft: (text: string) => {
      if (connection.sessionKey === current.current.sessionKey) chat.setPlanDraft(text)
      else if (connection.sessionKey) {
        const saved = drafts.get(connection.sessionKey)
        if (saved) drafts.set(connection.sessionKey, { ...saved, planDraft: text })
      }
    },
    chat: chat.chat,
    appSession,
    chatStream: chat.chatStream,
    loadOlderMessages,
    historyLoading,
    historyError,
    connection,
    hasConnected,
    state,
    models,
    commands: supportedCommands,
    uiPlugins,
    refreshSnapshot: refresh,
    refreshCommands: async () => {
      const expected = { ...current.current }
      const next = await bridge.getCommands()
      if (
        mounted.current &&
        current.current.sessionKey === expected.sessionKey &&
        current.current.generation === expected.generation
      )
        setCommands(next)
    },
    refreshUiPlugins,
    sessions,
    sessionsLoading,
    refreshMenu: async () => {
      await refreshSessions()
      await refresh()
    },
    applyMenuDeletion: async (result: WorkspaceDeletionResult) => {
      for (const key of result.deletedKeys) {
        drafts.delete(key)
        views.current.delete(key)
      }
      if (result.selection && !result.selection.cancelled) {
        const snapshot = result.selection.snapshot
        if (
          snapshot.connection.sessionKey === current.current.sessionKey &&
          snapshot.connection.generation === current.current.generation &&
          !selection.current.current
        ) {
          await refresh()
          setRefreshToken((value) => value + 1)
        }
      }
      await refreshSessions()
    },
    error,
    workspaceNotice,
    selectWorkspace,
    navigationDisabledReason:
      chat.editSubmitting || acting || modelSaving || connection.accessChanging || loading
        ? '正在保存会话或更新配置，请完成后再切换'
        : switching && !selection.current.current?.replaceable
          ? '正在创建分支或切换 Git，请完成后再切换会话'
          : undefined,
    workspaceDisabledReason: chat.editing
      ? '请先完成或取消历史消息编辑'
      : acting || switching || connection.accessChanging || loading
        ? '正在切换会话或更新配置，请稍后选择项目'
        : undefined,
    mode: chat.mode,
    changeMode: chat.changeMode,
    activatePlan: chat.activatePlan,
    activateGoal: chat.activateGoal,
    compactNow: chat.compactNow,
    goal: chat.chat.goal,
    goalsSupported: chat.chat.goalsSupported,
    goalDraft: chat.goalDraft,
    setGoalDraft: chat.setGoalDraft,
    goalOpen: chat.goalOpen,
    setGoalOpen: chat.setGoalOpen,
    goalEditing: chat.goalEditing,
    goalAction: chat.goalAction,
    saveGoal: chat.saveGoal,
    recoveredInputs: chat.recoveredInputs,
    restoreQueuedInput: chat.restoreQueuedInput,
    draft: chat.draft,
    composerHint: chat.composerHint,
    acceptComposerHint: chat.acceptComposerHint,
    dismissComposerHint: chat.dismissComposerHint,
    selectedSkills: chat.selectedSkills,
    setSelectedSkills: chat.setSelectedSkills,
    pluginMentions: chat.pluginMentions,
    setPluginMentions: chat.setPluginMentions,
    attachments: chat.attachments,
    sendingAttachments: chat.sendingAttachments,
    queueMode: chat.queueMode,
    ...extensions,
    extensionDialogs: switching ? [] : extensions.extensionDialogs,
    answerExtensionDialog: async (...args: Parameters<typeof extensions.answerExtensionDialog>) => {
      setError('')
      await extensions.answerExtensionDialog(...args)
    },
    accessBusy:
      loading ||
      acting ||
      switching ||
      previewing ||
      chat.chat.running ||
      connection.status === 'connecting' ||
      Boolean(connection.accessChanging),
    setAccessMode: (mode: AgentAccessMode) =>
      action(async (key, owns) => {
        try {
          await bridge.setAccessMode(key, mode)
        } finally {
          if (owns()) await refresh()
        }
      }),
    busy: inputDisabled || chat.chat.running,
    modelPickerDisabled,
    modelSaving,
    loadHistoryDetails,
    historyDetailsDeferred: Boolean(
      connection.sessionKey && views.current.get(connection.sessionKey)?.snapshot.historyDetails === 'deferred',
    ),
    retrySwitch: failedSwitchPath ? () => switchSession(failedSwitchPath) : undefined,
    cachedChat: (key: string) => views.current.get(key)?.chat,
    synchronizing: switching && previewing,
    navigationBusy: acting || switching,
    inputDisabled,
    draftEditable: Boolean(preview.current?.input) || !inputDisabled,
    contentLoading: switching && !previewing,
    loading,
    switching,
    switchingToPath,
    refreshToken,
    setDraft: chat.setDraft,
    composerStore: chat.composerStore,
    composerFiles: chat.composerFiles,
    canSubmitComposer: chat.canSubmitComposer,
    setSubmissionIntegration: chat.setSubmissionIntegration,
    dispatchPreparedComposer: chat.dispatchPreparedComposer,
    submitPlan: chat.submitPlan,
    submitVisualization: chat.submitVisualization,
    failedDrafts: chat.failedDrafts,
    restoreFailedDraft: chat.restoreFailedDraft,
    setError,
    extensionError,
    dismissExtensionError: () => {
      dismissedExtensionError.current = extensionError
      setExtensionError(undefined)
    },
    setAttachments: chat.setAttachments,
    setQueueMode: chat.setQueueMode,
    editing: chat.editing,
    editingEntryId: chat.editingEntryId,
    editSubmitting: chat.editSubmitting,
    selectedConfiguration: chat.selectedConfiguration,
    configurationChanged: chat.configurationChanged,
    editMessage: (message: Parameters<typeof chat.editMessage>[0]) => {
      chat.editMessage(message)
      extensions.focusDraft()
    },
    cancelEdit: chat.cancelEdit,
    chooseDirectory,
    newSession: () =>
      createSession(
        preview.current?.input ??
          (current.current.workspaceKind === 'standalone'
            ? { kind: 'standalone' }
            : { kind: 'project', cwd: current.current.cwd }),
      ),
    newSessionInProject: (cwd: string) => createSession({ kind: 'project', cwd }),
    switchSession,
    forkReply: (timestamp: number) => {
      const key = current.current.sessionKey
      const sourcePath = displayed.current.sessionFile ?? current.current.sessionFile
      if (!key) return Promise.resolve()
      setForkNotice(null)
      setForking(true)
      return select(() => bridge.forkReply(key, timestamp))
        .then(() => {
          // select 失败时会恢复原会话，这里用会话标识变化判断是否真的切到了新分支。
          if (current.current.sessionKey === key) return
          setForkNotice({ sourcePath: sourcePath ?? '' })
          if (forkNoticeTimer.current) clearTimeout(forkNoticeTimer.current)
          forkNoticeTimer.current = setTimeout(setForkNotice, 8000, null)
        })
        .finally(() => {
          if (mounted.current) setForking(false)
        })
    },
    forking,
    forkNotice,
    dismissForkNotice: () => setForkNotice(null),
    openForkSource: (sourcePath: string) => {
      setForkNotice(null)
      return switchSession(sourcePath)
    },
    togglePin: (path: string) =>
      action(async () => {
        await bridge.togglePin(path)
        await refreshSessions()
      }),
    refreshSessions,
    send: chat.send,
    submitComposer: chat.submitComposer,
    stop: chat.stop,
    resume: chat.resume,
    resumeQueue: chat.resumeQueue,
    recover: chat.recover,
    recovering: chat.recovering,
    steerQueueInput: chat.steerQueueInput,
    deleteQueueInput: chat.deleteQueueInput,
    editingQueue: chat.editingQueue,
    savingQueue: chat.savingQueue,
    editQueueInput: async (id: string) => {
      await chat.editQueueInput(id)
      extensions.focusDraft()
    },
    clearQueue: () => action(() => chat.clearQueue()),
    setSteeringMode: (mode: PiState['steeringMode']) =>
      action(async (key, owns) => {
        const next = await bridge.setSteeringMode(key, mode)
        if (owns()) setState(next)
      }),
    setFollowUpMode: (mode: PiState['followUpMode']) =>
      action(async (key, owns) => {
        const next = await bridge.setFollowUpMode(key, mode)
        if (owns()) setState(next)
      }),
    selectModel: (model: PiModel) => {
      if (chat.editSubmitting) return Promise.resolve(false)
      if (chat.editing || chat.chat.running || chat.chat.paused || chat.chat.queuePaused) {
        chat.updateConfiguration({
          model,
          thinkingLevel: resolveThinkingLevel(model, chat.selectedConfiguration.thinkingLevel ?? 'medium'),
        })
        return Promise.resolve(true)
      }
      if (!current.current.sessionKey || actionLock.current || selection.current.current) return Promise.resolve(false)
      if (state?.model?.provider === model.provider && state.model.id === model.id && !state.modelSelectionRequired)
        return Promise.resolve(true)
      const previousModel = state?.model
      const previousRequired = state?.modelSelectionRequired
      setModelSaving(true)
      modelSaveError.current = undefined
      const pending = action(async (key, owns) => {
        setState((value) => value && { ...value, model, modelSelectionRequired: false })
        try {
          const selected = await bridge.setModel(key, model)
          if (!owns()) return
          setState((value) => value && { ...value, model: selected, modelSelectionRequired: false })
          await refresh()
          const levels = await bridge.getAvailableThinkingLevels().catch(() => [])
          if (!owns()) return
          setThinkingLevels(levels)
        } catch (cause) {
          modelSaveError.current = cause
          if (owns())
            setState((value) => value && { ...value, model: previousModel, modelSelectionRequired: previousRequired })
          throw cause
        }
      }, false)
      modelSelection.current = pending
      void pending.then(() => {
        if (modelSelection.current === pending) modelSelection.current = null
        if (mounted.current) setModelSaving(false)
      })
      return pending
    },
    selectThinkingLevel: (level: ThinkingLevel) => {
      if (chat.editSubmitting) return
      if (chat.editing || chat.chat.running || chat.chat.paused || chat.chat.queuePaused) {
        chat.updateConfiguration({ thinkingLevel: level })
        return
      }
      const key = current.current.sessionKey
      const generation = current.current.generation
      const owns = () =>
        mounted.current && key === current.current.sessionKey && generation === current.current.generation
      if (!key || actionLock.current || selection.current.current || preview.current) return
      const request = ++thinkingRequest.current
      const previousLevel = state?.thinkingLevel
      synchronization.current.cancel()
      setError('')
      setState((value) => value && { ...value, thinkingLevel: level })
      thinkingSaveError.current = undefined
      const modelPending = modelSelection.current
      const pending = Promise.resolve(thinkingSelection.current)
        .catch(() => {})
        .then(async () => {
          if (modelPending && !(await modelPending)) throw modelSaveError.current ?? new Error('模型切换失败')
          await bridge.setThinkingLevel(key, level)
          const snapshot = await bridge.getSnapshot()
          if (owns() && request === thinkingRequest.current) {
            setState((value) => value && { ...value, thinkingLevel: snapshot.state.thinkingLevel })
            setThinkingLevels(snapshot.thinkingLevels ?? [])
          }
        })
      thinkingSelection.current = pending
      void pending.catch(async (cause) => {
        if (owns() && request === thinkingRequest.current) {
          thinkingSaveError.current = cause
          setError(String(cause))
          const savedLevel = await bridge
            .getSnapshot()
            .then((snapshot) => snapshot.state.thinkingLevel)
            .catch(() => previousLevel)
          if (owns() && request === thinkingRequest.current)
            setState((value) => value && { ...value, thinkingLevel: savedLevel })
        }
      })
    },
    thinkingLevels,
    sessionStats,
  }
}
