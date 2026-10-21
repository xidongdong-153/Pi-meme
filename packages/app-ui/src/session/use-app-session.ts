import type { PlanDocument } from '@pi-meme/contracts/plan'
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
import { applyEvent as reduceEvent } from '@pi-meme/chat/ui/model/state'
import type { ChatState } from '@pi-meme/chat/ui/model/types'
import { useChatSession, type ComposerSnapshot } from '@pi-meme/chat/ui/use-chat-session'
import { useExtensionUI } from '@pi-meme/interaction/ui/use-extension-ui'
import { useSessions } from '@pi-meme/workspace/ui/use-sessions'
import { SessionSelection } from './session-selection'
import { SnapshotSync } from './snapshot-sync'
import { PluginSnapshotSync } from './plugin-snapshot-sync'
import { ComposerDrafts } from './composer-drafts'

/** 主对话事件订阅；选择事务和快照读取分别隔离过期结果，子代理对话独立订阅。 */
export function useAppSession(
  bridge: DesktopBridge,
  {
    chatEnabled = true,
    workspaceEnabled = true,
    hostId = '',
    onPlanSaved,
  }: {
    chatEnabled?: boolean
    workspaceEnabled?: boolean
    hostId?: string
    onPlanSaved?: (document: PlanDocument, sessionKey: string | undefined) => void
  } = {},
) {
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
  const [switchingToPath, setSwitchingToPath] = useState<string>()
  const [forking, setForking] = useState(false)
  const [forkNotice, setForkNotice] = useState<{ sourcePath: string } | null>(null)
  const forkNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const currentRootAgentId = useRef<string | undefined>(undefined)
  const currentAgentTree = useRef<import('@pi-meme/contracts/collaboration').AgentSummary[]>([])
  const [planDocuments, setPlanDocuments] = useState<PlanDocument[]>([])
  const current = useRef(connection)
  const displayed = useRef(connection)
  const mounted = useRef(false)
  const actionLock = useRef(false)
  const modelSelection = useRef<Promise<boolean> | null>(null)
  const modelSaveError = useRef<unknown>(undefined)
  const thinkingRequest = useRef(0)
  const selection = useRef(new SessionSelection())
  const synchronization = useRef(new SnapshotSync())
  const pluginSynchronization = useRef(new PluginSnapshotSync())
  const views = useRef(new Map<string, { snapshot: Snapshot; chat: ChatState; sequence: number }>())
  const synced = useRef<{ generation: number; sessionKey?: string; status?: string } | undefined>(undefined)
  const drafts = useMemo(() => new ComposerDrafts(hostId), [hostId])
  const chatRef = useRef<ReturnType<typeof useChatSession> | null>(null)
  const extensionsRef = useRef<ReturnType<typeof useExtensionUI> | null>(null)
  const { sessions, sessionsLoading, refreshSessions, setActiveSession } = useSessions(bridge, workspaceEnabled)

  const commitSnapshot = useCallback(
    (snapshot: Snapshot, events: DesktopEvent[] | null, pluginRevision: number, modeRevision?: number) => {
      const previousKey = displayed.current.sessionKey
      const previousGeneration = displayed.current.generation
      currentRootAgentId.current = snapshot.agent?.rootAgentId ?? snapshot.agent?.agentId
      currentAgentTree.current = snapshot.agents ?? []
      setPlanDocuments(snapshot.planDocuments ?? [])
      displayed.current = snapshot.connection
      current.current = snapshot.connection
      setConnection(snapshot.connection)
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
      // 权威快照空闲时清除发送挂起标记，避免下一条消息被当成插话/排队。
      if (!snapshot.state.isStreaming && !snapshot.state.isCompacting) chatRef.current?.clearPromptPending()
      const key = snapshot.connection.sessionKey
      if (key && next)
        views.current.set(key, {
          snapshot,
          chat: next,
          sequence: Math.max(
            snapshot.eventSequence ?? 0,
            ...(events ?? []).filter((record) => record.sessionKey === key).map((record) => record.sequence ?? 0),
          ),
        })
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
    if (selection.current.current) return
    const modeRevision = chatRef.current?.captureModeRevision()
    const read = synchronization.current.begin(current.current)
    const pluginRevision = pluginSynchronization.current.begin()
    try {
      const [snapshot, nextCommands] = await Promise.all([
        bridge.getSnapshot(),
        chatEnabled
          ? bridge.getCommands().catch((cause) => {
              if (mounted.current && synchronization.current.owns(read, current.current))
                setError(`无法读取会话命令：${String(cause)}`)
              return [] as PiSlashCommand[]
            })
          : Promise.resolve([] as PiSlashCommand[]),
      ])
      if (
        !mounted.current ||
        !synchronization.current.owns(read, current.current) ||
        snapshot.connection.generation !== current.current.generation ||
        snapshot.connection.sessionKey !== current.current.sessionKey
      )
        return
      commitSnapshot(snapshot, read.events, pluginRevision, modeRevision)
      setCommands(nextCommands)
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
  }, [bridge, chatEnabled, commitSnapshot])

  const refreshUiPlugins = useCallback(async () => {
    const connection = current.current
    const pluginRevision = pluginSynchronization.current.begin()
    let snapshot: Snapshot
    try {
      snapshot = await bridge.getSnapshot()
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
  }, [bridge])

  const chatBridge = useMemo(() => {
    function afterModelSelection<Args extends unknown[], Result>(send: (...args: Args) => Promise<Result>) {
      return async (...args: Args) => {
        const pending = modelSelection.current
        if (pending && !(await pending)) throw modelSaveError.current ?? new Error('模型切换失败，消息尚未发送')
        return send.apply(bridge, args)
      }
    }
    return {
      ...bridge,
      prompt: afterModelSelection(bridge.prompt),
      followUp: afterModelSelection(bridge.followUp),
      editAndPrompt: afterModelSelection(bridge.editAndPrompt),
    }
  }, [bridge])
  const chat = useChatSession({
    bridge: chatBridge,
    refresh,
    commands,
    canSend: () =>
      !loading &&
      !acting &&
      !switching &&
      !current.current.accessChanging &&
      (current.current.status === 'ready' || current.current.status === 'idle') &&
      !state?.modelSelectionRequired,
    isSwitching: () => selection.current.current !== null,
    awaitPendingSwitch: async () => {
      await selection.current.pending
    },
    currentGeneration: () => current.current.generation,
    currentSessionKey: () => current.current.sessionKey,
    onError: setError,
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
  const bindDraftSession = useCallback(
    (key: string, sessionId: string) => {
      const saved = drafts.bind(key, sessionId)
      if (saved && key === current.current.sessionKey && !selection.current.current)
        chatRef.current?.restoreComposer(saved)
    },
    [drafts],
  )
  useEffect(() => {
    if (connection.sessionKey && !switching) drafts.set(connection.sessionKey, chat.captureComposer())
  }, [
    drafts,
    connection.sessionKey,
    switching,
    chat.draft,
    chat.goalDraft,
    chat.selectedSkills,
    chat.pluginMentions,
    chat.pluginAnchors,
    chat.attachments,
    chat.queueMode,
    chat.editingTimestamp,
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
      if (selection.current.current) return
      setConnection(next)
      setActiveSession(next.sessionFile ?? next.sessionKey, next.sessionKey)
      if (next.error) setError(next.error)
      else if (next.status === 'ready' && previous.status !== 'ready') setError('')
      if (selection.current.current) return
      if (next.generation !== previous.generation || next.sessionKey !== previous.sessionKey) {
        synchronization.current.cancel()
        if (previous.sessionKey && chatRef.current) drafts.set(previous.sessionKey, chatRef.current.captureComposer())
        if (next.sessionKey !== previous.sessionKey) {
          currentRootAgentId.current = undefined
          currentAgentTree.current = []
          setPlanDocuments([])
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
    const offEvent = bridge.onEvent((record) => {
      if (!mounted.current) return
      selection.current.current?.events.push(record)
      synchronization.current.receive(record)
      const event = record.event
      if (event.type === 'access_mode_changed') {
        if (record.sessionKey === current.current.sessionKey && record.generation === current.current.generation) {
          current.current = { ...current.current, accessMode: event.mode }
          setConnection(current.current)
        }
        return
      }
      const extension =
        event.type === 'extension_ui_request' ||
        event.type === 'extension_ui_timeout' ||
        event.type === 'extension_ui_closed'
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
          chatRef.current?.applyEvent({ ...event, agents: currentAgentTree.current })
        }
        return
      }
      if (event.type === 'agent_mailbox') {
        if (
          record.sessionKey === current.current.sessionKey ||
          currentAgentTree.current.some((agent) => agent.rootTaskId === event.message.rootTaskId)
        )
          chatRef.current?.applyEvent(event)
        return
      }
      if (event.type === 'plan_saved') {
        if (
          selection.current.current ||
          record.generation !== current.current.generation ||
          record.sessionKey !== current.current.sessionKey
        )
          return
        const known = chatRef.current?.captureChat().planDocuments?.find((doc) => doc.id === event.document.id)
        if (known && known.revision >= event.document.revision) return
        setPlanDocuments((value) => [...value.filter((doc) => doc.id !== event.document.id), event.document])
        chatRef.current?.applyEvent(event)
        onPlanSavedRef.current?.(event.document, record.sessionKey)
        return
      }
      const cached = record.sessionKey && views.current.get(record.sessionKey)
      if (cached && record.sequence !== undefined && record.sequence <= cached.sequence) return
      if (cached && !extension) {
        cached.chat = reduceEvent(cached.chat, event)
        cached.sequence = record.sequence ?? cached.sequence
      }
      if (
        selection.current.current ||
        record.generation !== current.current.generation ||
        record.sessionKey !== current.current.sessionKey
      )
        return
      if (event.type === 'agent_settled') chatRef.current?.clearPromptPending()
      chatRef.current?.applyEvent(event)
      if (event.type === 'message_end' && event.message.role === 'assistant') void refreshStats()
      if (event.type === 'agent_settled' || event.type === 'compaction_end') {
        setRefreshToken((value) => value + 1)
        void refresh()
      }
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
    if (!key || actionLock.current || selection.current.current) return false
    actionLock.current = true
    synchronization.current.cancel()
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
  ) => {
    if (actionLock.current) return false
    let succeeded = false
    const replacing = selection.current.current !== null
    const transaction = selection.current.begin(target)
    const pluginRevision = pluginSynchronization.current.begin()
    const modeRevision = chatRef.current?.captureModeRevision()
    const owns = () => mounted.current && selection.current.owns(transaction)
    const previousMode = chatRef.current?.mode
    const previous = displayed.current
    const previousPath = previous.sessionFile ?? previous.sessionKey
    const previousComposer =
      replacing && previous.sessionKey ? drafts.get(previous.sessionKey) : chatRef.current?.captureComposer()
    const previousView = previous.sessionKey && views.current.get(previous.sessionKey)
    if (previous.sessionKey && previousComposer) drafts.set(previous.sessionKey, previousComposer)
    if (!replacing && previousView && chatRef.current) previousView.chat = chatRef.current.captureChat()
    synchronization.current.cancel()
    setSwitching(true)
    setSwitchingToPath(target)
    setLoading(false)
    setError('')
    if (target) setActiveSession(target)
    chatRef.current?.clearPromptPending()
    const pending = (async () => {
      try {
        const result = await work()
        if (!owns()) return
        if (result.cancelled) {
          const snapshot = await bridge.getSnapshot()
          if (!owns()) return
          commitSnapshot(snapshot, transaction.events, pluginRevision, modeRevision)
          if (previousComposer) chatRef.current?.restoreComposer(previousComposer)
          setActiveSession(previousPath, previous.sessionKey)
          return
        }
        let transferred: ReturnType<typeof transferDraft> | undefined
        if (carryDraft && previousComposer) {
          const nextCommands = result.commands ?? (await bridge.getCommands())
          if (!owns()) return
          transferred = transferDraft(previousComposer, nextCommands)
          setCommands(nextCommands)
        }
        const draft =
          transferred?.composer ??
          (result.snapshot.connection.sessionKey && drafts.get(result.snapshot.connection.sessionKey))
        commitSnapshot(result.snapshot, transaction.events, pluginRevision, modeRevision)
        if (draft) chatRef.current?.restoreComposer(draft)
        else chatRef.current?.clearComposer()
        if (transferred) {
          if (previousMode) chatRef.current?.changeMode(previousMode)
          if (previous.sessionKey) drafts.delete(previous.sessionKey)
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
              if (mounted.current && !selection.current.current && generation === current.current.generation)
                setCommands(nextCommands)
            })
            .catch(() => {})
      } catch (cause) {
        if (!owns()) return
        try {
          if (current.current.sessionKey !== previous.sessionKey && previousPath) {
            const restored = await bridge.switchSession(previousPath)
            if (!owns()) return
            if (!restored.cancelled) commitSnapshot(restored.snapshot, transaction.events, pluginRevision, modeRevision)
          } else {
            const snapshot = await bridge.getSnapshot()
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
            const snapshot = await bridge.getSnapshot()
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
          setSwitchingToPath(undefined)
          void refreshSessions()
        }
      }
    })()
    selection.current.pending = pending
    await pending
    return succeeded
  }

  const selectWorkspace = (input: SelectWorkspace) => {
    if (chat.editing || actionLock.current || current.current.accessChanging) return Promise.resolve(false)
    if (
      (input.kind === 'standalone' && current.current.workspaceKind === 'standalone') ||
      (input.kind === 'project' && input.cwd === current.current.cwd)
    )
      return Promise.resolve(true)
    return select(() => bridge.selectWorkspace(input), undefined, true)
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
  // 统计、思考档位和扩展状态不再因切换清空；输入仍按原规则在切换期间只读，避免写入旧会话。
  const inputDisabled =
    loading ||
    acting ||
    switching ||
    (connection.status !== 'ready' && connection.status !== 'idle') ||
    Boolean(connection.accessChanging) ||
    Boolean(state?.modelSelectionRequired)
  const modelPickerDisabled =
    loading ||
    acting ||
    switching ||
    chat.chat.running ||
    (connection.status !== 'ready' && connection.status !== 'idle') ||
    Boolean(connection.accessChanging)
  const supportedCommands = useMemo(
    () =>
      commands.filter((command) => command.name !== 'goal' || command.source !== 'builtin' || chat.chat.goalsSupported),
    [commands, chat.chat.goalsSupported],
  )

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
      const changed = await select(
        () =>
          input.kind === 'project' && input.cwd === current.current.cwd
            ? bridge.newSession()
            : input.kind === 'standalone' && current.current.workspaceKind === 'standalone'
              ? bridge.newSession()
              : bridge.selectWorkspace(input),
        undefined,
        !incoming,
        !incoming,
      )
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
    planDocuments,
    chat: chat.chat,
    chatStream: chat.chatStream,
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
    workspaceDisabledReason: chat.editing
      ? '请先完成或取消历史消息编辑'
      : acting || switching || connection.accessChanging || loading
        ? '正在切换会话或更新配置，请稍后选择项目'
        : undefined,
    mode: chat.mode,
    changeMode: chat.changeMode,
    activatePlan: chat.activatePlan,
    activateGoal: chat.activateGoal,
    goal: chat.chat.goal,
    goalsSupported: chat.chat.goalsSupported,
    goalDraft: chat.goalDraft,
    setGoalDraft: chat.setGoalDraft,
    goalOpen: chat.goalOpen,
    setGoalOpen: chat.setGoalOpen,
    goalEditing: chat.goalEditing,
    goalAction: chat.goalAction,
    saveGoal: chat.saveGoal,
    setMessageGoal: chat.setMessageGoal,
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
    navigationBusy: acting || switching,
    inputDisabled,
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
    editingTimestamp: chat.editingTimestamp,
    editMessage: (message: Parameters<typeof chat.editMessage>[0]) => {
      chat.editMessage(message)
      extensions.focusDraft()
    },
    cancelEdit: chat.cancelEdit,
    chooseDirectory,
    newSession: () => select(() => bridge.newSession()),
    newSessionInProject: (cwd: string) =>
      cwd === current.current.cwd
        ? select(() => bridge.newSession())
        : select(() => bridge.selectWorkspace({ kind: 'project', cwd })),
    switchSession: (sessionPath: string) => select(() => bridge.switchSession(sessionPath), sessionPath),
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
      return select(() => bridge.switchSession(sourcePath), sourcePath)
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
          const levels = await bridge.getAvailableThinkingLevels().catch(() => [])
          if (!owns()) return
          setState((value) => value && { ...value, model: selected, modelSelectionRequired: false })
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
      const key = current.current.sessionKey
      const generation = current.current.generation
      const owns = () =>
        mounted.current && key === current.current.sessionKey && generation === current.current.generation
      if (!key || actionLock.current || selection.current.current) return
      const request = ++thinkingRequest.current
      const previousLevel = state?.thinkingLevel
      synchronization.current.cancel()
      setError('')
      setState((value) => value && { ...value, thinkingLevel: level })
      void bridge.setThinkingLevel(key, level).catch(async (cause) => {
        if (owns() && request === thinkingRequest.current) {
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
