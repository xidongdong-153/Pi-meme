import type { GoalControl } from '@pi-meme/contracts/goal'
import { validateExtensionDialogResponse } from '@pi-meme/contracts/user-input'
import { normalizePlanMessage, type TaskMode, type MessageOptions } from '@pi-meme/contracts/plan'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ToolExecutionSettings } from '@pi-meme/contracts/settings'
import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import { realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defaultAccessMode, isAgentAccessMode, type AgentAccessMode } from '@pi-meme/contracts/agent-access'
import { AgentAccessStore } from './access-store'
import { builtinCommand, builtinCommands, sameMessage, thinkingLevels } from '@pi-meme/contracts/pi'
import { randomUUID } from 'node:crypto'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import type { PiSdk } from './sdk/load'
import type {
  Connection,
  DesktopError,
  DesktopEvent,
  Snapshot,
  SessionSelectionResult,
  WorkspaceDeletionResult,
} from '@pi-meme/contracts/desktop'
import type { SkillReference } from '@pi-meme/contracts/skills'
import type { ResourceSnapshot } from '@pi-meme/contracts/resources'
import type { PiSessionSummary, WorkspaceKind } from '@pi-meme/contracts/sessions'
import type {
  PiExtensionEvent,
  PiExtensionUIResponse,
  PiMessage,
  PiImage,
  PiModel,
  PiSessionEntry,
  PiSlashCommand,
  PiState,
  ThinkingLevel,
} from '@pi-meme/contracts/pi'
import type { SandboxCapability } from './sdk/access-sandbox'
import { SdkSession } from './sdk/session'
import { recoveryMessage } from './sdk/recovery'
import { getPiVersion, loadPiSdk } from './sdk/load'
import type { ModelRestore, PiRuntime } from './runtime'
import { invalidateSessionHistory, readSessionHistory, type SessionHistoryData } from './session-history'
import { readLocalModels, readLocalPreferences, readLocalSkills } from './session-metadata'
import { createPiRuntimePaths, type PiRuntimePaths } from './runtime-paths'
import { MemoryCredentialStorage } from './secure-store'

function activePath<T extends { id: string; parentId: string | null }>(entries: T[], leafId: string | null) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const path: T[] = []
  let entry = leafId ? byId.get(leafId) : undefined
  while (entry) {
    path.push(entry)
    entry = entry.parentId ? byId.get(entry.parentId) : undefined
  }
  return path.reverse()
}

function messageEntry(entry: PiSessionEntry): entry is Extract<PiSessionEntry, { type: 'message' }> {
  return entry.type === 'message'
}

function pathWithin(root: string, value: string) {
  const relative = path.relative(path.resolve(root), path.resolve(value))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

type RuntimeSession = {
  key: string
  accessMode: AgentAccessMode
  accessReady: Promise<void>
  accessChanging: boolean
  stopping: boolean
  cwd: string
  session: RuntimeSdkSession
  sessionFile?: string
  restored: boolean
  dormant: boolean
  starting?: Promise<void>
  retiring?: Promise<void>
  cancelledPrompt: boolean
  error?: string
  extensionError?: DesktopError
  state: PiState
  running: boolean
  pendingPrompt: boolean
  settled: boolean
  run: number
  touched: number
  created: string
  name?: string
  completedAt?: string | null
  firstMessage?: string
  messages: PiMessage[]
  sessionEntries?: Snapshot['sessionEntries']
  branchAttachments?: Snapshot['branchAttachments']
  sequence: number
  executionRunId?: string
  executionGeneration: number
  modeRevision?: number
  liveEvents: DesktopEvent[]
  tools: Map<string, DesktopEvent>
  queue?: DesktopEvent
  extensions: Map<string, DesktopEvent>
  answers: Set<string>
  buffers: Set<DesktopEvent[]>
  stats?: Snapshot['stats']
}

export type RuntimeSdkSession = Pick<SdkSession, keyof SdkSession>
export type SessionFactory = (
  ...args: [
    cwd: string,
    notify: ConstructorParameters<typeof SdkSession>[1],
    paths: PiRuntimePaths,
    credentials: SecureCredentialStorage,
    mcp?: ConstructorParameters<typeof SdkSession>[4],
    sessionKey?: string,
  ]
) => RuntimeSdkSession
export type ClientView = {
  clientId?: string
  sessionKey?: string
  generation: number
  selection: number
  defaults?: Pick<PiState, 'model' | 'thinkingLevel' | 'steeringMode' | 'followUpMode'> | null
}

export type CollaborationLifecycle = {
  pause?: (sessionKey: string) => Promise<void>
  resume?: (sessionKey: string) => Promise<void>
  modeChanged?: (sessionKey: string, mode: TaskMode) => Promise<void>
  decorateEvent?: (sessionKey: string, event: DesktopEvent) => DesktopEvent
  beforePrompt: (sessionKey: string, input: { mode: TaskMode; message: string }) => Promise<void>
  settled: (sessionKey: string, event: { aborted?: boolean; runId?: string }) => void | Promise<void>
  failed: (sessionKey: string, cause: unknown, runId?: string) => void | Promise<void>
  stop: (sessionKey: string) => void | Promise<void>
}
export class PiSessionPool implements PiRuntime {
  private aborts = new Map<string, Promise<void>>()
  private goalSessions = new Set<string>()
  goalStopStamp(key: string) {
    const record = this.sessions.get(key)
    return record ? `${record.run}:${record.session.connection().generation}` : undefined
  }
  retainGoalSession(key: string, retain: boolean) {
    if (retain) this.goalSessions.add(key)
    else this.goalSessions.delete(key)
  }
  hasRunningGoalTools(key: string) {
    return [...(this.sessions.get(key)?.tools.values() ?? [])].some(
      ({ event }) =>
        (event.type === 'tool_execution_start' || event.type === 'tool_execution_update') &&
        event.toolName !== 'update_goal',
    )
  }
  hasPendingGoalInput(key: string) {
    const record = this.sessions.get(key)
    return (
      !!record &&
      !!(
        record.state.pendingMessageCount ||
        (record.queue?.event.type === 'queue_update' &&
          (record.queue.event.steering.length || record.queue.event.followUp.length))
      )
    )
  }
  isSessionIdle(key: string, allowQueued = false) {
    const record = this.sessions.get(key)
    return (
      !!record &&
      !this.changing &&
      !record.running &&
      !record.pendingPrompt &&
      !record.starting &&
      !record.retiring &&
      !record.stopping &&
      !record.accessChanging &&
      (allowQueued || (!record.state.isPaused && !record.state.queuePaused)) &&
      !record.state.isCompacting &&
      !record.state.retry &&
      (allowQueued ||
        !(
          record.queue?.event.type === 'queue_update' &&
          (record.queue.event.steering.length || record.queue.event.followUp.length)
        ))
    )
  }
  private collaboration?: CollaborationLifecycle
  configureCollaboration(value: CollaborationLifecycle) {
    this.collaboration = value
  }

  private checkoutGate?: (cwd: string) => void
  configureCheckoutGate(assertAvailable: (cwd: string) => void) {
    this.checkoutGate = assertAvailable
  }
  assertMaintenanceIdle() {
    this.assertCheckoutIdle(() => true)
    if (
      [...this.sessions.values()].some(
        (record) => record.state.isPaused || record.state.queuePaused || record.state.isCompacting,
      )
    )
      throw new Error('仍有暂停或整理中的会话，请先处理后再维护存储')
  }
  assertCheckoutIdle(matches: (cwd: string) => boolean) {
    const records = [...this.sessions.values()].filter((record) => matches(record.cwd))
    this.assertMutable(records)
    if (
      records.some(
        (record) =>
          [...record.extensions.keys()].some((key) => key.startsWith('dialog:')) ||
          (record.queue?.event.type === 'queue_update' &&
            (record.queue.event.steering.length || record.queue.event.followUp.length)),
      )
    )
      throw new Error('此工作目录仍有排队消息或待答交互，请先处理')
  }
  async retireCheckout(matches: (cwd: string) => boolean) {
    await this.retireSessions((key) => matches(this.sessions.get(key)!.cwd))
    for (const key of this.commands.keys())
      if ([...this.sessions.values()].some((record) => matches(record.cwd) && key.startsWith(`${record.cwd}:`)))
        this.commands.delete(key)
  }
  private sessions = new Map<string, RuntimeSession>()
  private readonly settledListeners = new Set<() => void>()
  private signalSettled() {
    for (const resolve of this.settledListeners) resolve()
    this.settledListeners.clear()
  }
  async retireSessions(matches: (sessionKey: string) => boolean, ready?: () => Promise<void>) {
    const unsettled = (record: RuntimeSession) =>
      record.running ||
      record.pendingPrompt ||
      record.starting ||
      record.stopping ||
      record.accessChanging ||
      record.state.isCompacting ||
      record.session.connection().status === 'connecting' ||
      (record.queue?.event.type === 'queue_update' &&
        (record.queue.event.steering.length > 0 || record.queue.event.followUp.length > 0)) ||
      [...record.extensions.keys()].some((key) => key.startsWith('dialog:'))
    const records = [...this.sessions.values()].filter((record) => matches(record.key))
    await Promise.all(
      records.map((record) => {
        if (record.retiring) return record.retiring
        const retiring = (async () => {
          while (this.sessions.has(record.key)) {
            while (this.sessions.has(record.key) && unsettled(record))
              await new Promise<void>((resolve) => this.settledListeners.add(resolve))
            if (!this.sessions.has(record.key)) return
            await ready?.()
            if (unsettled(record)) continue
            if (!record.dormant && record.session.connection().status === 'ready') {
              this.rememberSnapshot(record, await record.session.snapshot())
              if (unsettled(record)) continue
              try {
                await record.session.assertResourceIdle()
              } catch (cause) {
                if (!/仍在准备排队输入或交付消息|Pi 正在运行/.test(String(cause))) throw cause
                await new Promise<void>((resolve) => setTimeout(resolve, 25))
                continue
              }
            }
            if (!unsettled(record)) break
          }
          if (!this.sessions.has(record.key)) return
          record.dormant = true
          record.extensions.clear()
          record.extensionError = undefined
          await record.session.stopAndWait()
        })().finally(() => {
          record.retiring = undefined
          this.signalSettled()
        })
        record.retiring = retiring
        return retiring
      }),
    )
    return records.length > 0
  }
  private readonly retired = new Set<Promise<void>>()
  private stopRecord(record: RuntimeSession) {
    const pending = record.session.stopAndWait()
    const interval = record.state.runIntervals?.at(-1)
    if (interval && interval.endedAt === undefined)
      record.state = {
        ...record.state,
        runIntervals: record.state.runIntervals?.map((value) =>
          value === interval ? { ...value, endedAt: Date.now() } : value,
        ),
      }
    this.retired.add(pending)
    void pending.finally(() => this.retired.delete(pending)).catch(() => {})
  }
  async stopAndWait() {
    this.changing = true
    this.clearWarmup()
    const retained = [...this.sessions.values()]
    await Promise.all([...this.retired, ...retained.map((record) => record.session.stopAndWait())])
    this.sessions.clear()
    this.signalSettled()
  }
  private defaultActive!: RuntimeSession
  private readonly viewContext = new AsyncLocalStorage<ClientView>()
  private readonly views = new Set<ClientView>()
  private defaultGeneration = 0
  private get active(): RuntimeSession {
    const view = this.viewContext.getStore()
    return view ? this.sessions.get(view.sessionKey ?? '')! : this.defaultActive
  }
  private set active(value: RuntimeSession) {
    const view = this.viewContext.getStore()
    if (view) view.sessionKey = value.key
    else this.defaultActive = value
  }
  private get generation() {
    return this.viewContext.getStore()?.generation ?? this.defaultGeneration
  }
  private set generation(value: number) {
    const view = this.viewContext.getStore()
    if (view) view.generation = value
    else this.defaultGeneration = value
  }
  createClientView(): ClientView {
    const view = { generation: 0, selection: 0 }
    this.views.add(view)
    return view
  }
  releaseClientView(view: ClientView) {
    this.views.delete(view)
    const record = this.sessions.get(view.sessionKey ?? '')
    if (
      record &&
      ![...this.views].some((other) => other.sessionKey === record.key) &&
      !record.accessChanging &&
      !this.hasContent(record)
    ) {
      this.sessions.delete(record.key)
      this.stopRecord(record)
    }
  }
  withClientView<T>(view: ClientView, action: () => T): T {
    if (this.views.has(view)) return this.viewContext.run(view, action)
    this.views.add(view)
    try {
      const result = this.viewContext.run(view, action)
      if (result instanceof Promise) return result.finally(() => this.views.delete(view)) as T
      this.views.delete(view)
      return result
    } catch (cause) {
      this.views.delete(view)
      throw cause
    }
  }
  initializeClient(cwd: string) {
    if (!this.active) void this.warmMetadata(this.create(cwd))
  }
  withSession<T>(sessionKey: string, action: () => T): T {
    const record = this.sessions.get(sessionKey)
    if (!record) throw new Error('目标会话不存在')
    const view = this.viewContext.getStore()
    return this.viewContext.run({ sessionKey, generation: view?.generation ?? 0, selection: 0 }, action)
  }
  private selectedElsewhere(record: RuntimeSession) {
    const current = this.viewContext.getStore()
    return [...this.views].some((view) => view !== current && view.sessionKey === record.key)
  }
  private executable = ''
  private changing = false
  private warmupTimer: NodeJS.Timeout | null = null
  private deletingCwds = new Set<string>()
  private mutatingPaths = new Set<string>()

  assertWorkspaceAvailable(cwd: string) {
    if (this.deletingCwds.has(cwd)) throw new Error('正在删除项目会话，请稍后操作')
  }
  private assertPathAvailable(path: string) {
    if (this.mutatingPaths.has(path)) throw new Error('正在修改或删除会话，请稍后操作')
  }
  private clearWarmup() {
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer)
      this.warmupTimer = null
    }
  }
  private recordPath(record: RuntimeSession) {
    return record.session.getActiveSession().sessionFile ?? record.sessionFile ?? record.key
  }
  private assertMutable(records: RuntimeSession[]) {
    if (
      this.changing ||
      records.some(
        (record) =>
          record.running ||
          record.pendingPrompt ||
          record.starting ||
          record.stopping ||
          record.accessChanging ||
          record.session.connection().status === 'connecting',
      )
    )
      throw new Error('目标会话正在运行或修改配置，请先停止任务')
  }
  async renameSession(sessionPath: string, name: string) {
    this.assertPathAvailable(sessionPath)
    if (!sessionPath.startsWith('runtime:')) {
      const sessionRoot = await realpath(this.runtimePaths.sessionsDirectory).catch(() => '')
      const sessionTarget = await realpath(sessionPath).catch(() => '')
      if (!sessionRoot || !sessionTarget || !pathWithin(sessionRoot, sessionTarget))
        throw new Error('Desktop 只能修改应用内保存的会话')
    }
    const record = [...this.sessions.values()].find(
      (item) => item.key === sessionPath || this.recordPath(item) === sessionPath,
    )
    if (record) {
      this.checkoutGate?.(record.cwd)
      this.assertWorkspaceAvailable(record.cwd)
      this.assertPathAvailable(record.key)
    }
    this.assertMutable(record ? [record] : [])
    this.mutatingPaths.add(sessionPath)
    if (record) this.mutatingPaths.add(record.key)
    try {
      if (record && !record.dormant && record.session.connection().status === 'ready') {
        await record.session.setSessionName(name)
      } else if (!sessionPath.startsWith('runtime:')) {
        const { SessionManager } = await loadPiSdk()
        const cwd = record?.cwd ?? (await readSessionHistory(sessionPath)).cwd
        const sessionDirectory = this.runtimePaths.sessionDirectory(cwd)
        SessionManager.open(sessionPath, sessionDirectory, cwd).appendSessionInfo(name)
      }
      if (record) {
        record.name = name
        record.state = { ...record.state, sessionName: name }
      }
      invalidateSessionHistory([sessionPath])
      this.notify.sessionsChanged()
    } finally {
      this.mutatingPaths.delete(sessionPath)
      if (record) this.mutatingPaths.delete(record.key)
    }
  }
  async deleteSessions(
    paths: string[],
    cwd: string | undefined,
    removeFiles: () => Promise<{ deletedPaths: string[]; errors: string[]; warnings?: string[] }>,
    finish?: (result: WorkspaceDeletionResult) => Promise<WorkspaceDeletionResult>,
  ): Promise<WorkspaceDeletionResult> {
    if (cwd) this.assertWorkspaceAvailable(cwd)
    for (const target of paths) this.assertPathAvailable(target)
    if (cwd) this.deletingCwds.add(cwd)
    for (const target of paths) this.mutatingPaths.add(target)
    let records: RuntimeSession[] = []
    const lockedKeys: string[] = []
    try {
      const all = [...this.sessions.values()]
      const normalized = await Promise.all(
        all.map(async (record) => ({ record, cwd: await realpath(record.cwd).catch(() => record.cwd) })),
      )
      records = normalized
        .filter(
          (item) =>
            (cwd && item.cwd === cwd) ||
            paths.includes(this.recordPath(item.record)) ||
            paths.includes(item.record.key),
        )
        .map((item) => item.record)
      if (
        this.changing ||
        records.some(
          (record) => record.starting || record.accessChanging || record.session.connection().status === 'connecting',
        )
      )
        throw new Error('目标会话正在初始化或修改配置，请稍后重试')
      for (const record of records) {
        if (!paths.includes(record.key)) this.assertPathAvailable(record.key)
        this.mutatingPaths.add(record.key)
        lockedKeys.push(record.key)
      }
      await Promise.all(
        records.map(async (record) => {
          record.cancelledPrompt = true
          await this.aborts.get(record.key)
          await this.collaboration?.stop(record.key)
          await record.session.stopAndWait()
          record.running = false
          record.pendingPrompt = false
          record.state = {
            ...record.state,
            isStreaming: false,
            isCompacting: false,
            isPaused: false,
            queuePaused: false,
          }
          record.queue = undefined
          record.dormant = true
          record.extensions.clear()
        }),
      )
      const replacementCwd =
        records.includes(this.active) && cwd ? await this.workspaceOptions!.createStandaloneDirectory() : undefined
      const result = await removeFiles()
      const deleted = new Set(result.deletedPaths)
      const removed = records.filter((record) => deleted.has(this.recordPath(record)) || (cwd && !result.errors.length))
      const deletedKeys = removed.map((record) => record.key)
      const activeRemoved = removed.includes(this.active)
      const previous = this.active
      for (const record of removed) this.sessions.delete(record.key)
      invalidateSessionHistory(result.deletedPaths)
      let selected: SessionSelectionResult | undefined
      if (activeRemoved) {
        const nextCwd = replacementCwd ?? previous.cwd
        this.selection += 1
        this.create(nextCwd)
        try {
          selected = await this.selectionResult(this.selection)
        } catch (cause) {
          result.errors.push(`会话已删除，无法读取新会话：${String(cause)}`)
        }
      }
      this.notify.sessionsChanged()
      const outcome = { ...result, deletedKeys, selection: selected }
      return finish ? await finish(outcome) : outcome
    } finally {
      if (cwd) this.deletingCwds.delete(cwd)
      for (const target of paths) this.mutatingPaths.delete(target)
      for (const key of lockedKeys) this.mutatingPaths.delete(key)
    }
  }
  private defaultPreferences: ClientView['defaults'] = null
  private get defaults() {
    return this.viewContext.getStore()?.defaults ?? this.defaultPreferences
  }
  private set defaults(value: ClientView['defaults']) {
    const view = this.viewContext.getStore()
    if (view) view.defaults = value
    else this.defaultPreferences = value
  }
  private thinkingLevels: ThinkingLevel[] = [...thinkingLevels]
  private epoch = 0
  private commands = new Map<string, PiSlashCommand[]>()
  private defaultSelection = 0
  private get selection() {
    return this.viewContext.getStore()?.selection ?? this.defaultSelection
  }
  private set selection(value: number) {
    const view = this.viewContext.getStore()
    if (view) view.selection = value
    else this.defaultSelection = value
  }
  private localModels: Promise<PiModel[]> | null = null
  private localAvailableModels: PiModel[] | null = null
  private resourceDiscovery = true
  private getResources?: (cwd: string) => Promise<ResourceSnapshot>
  configureResources(getResources: (cwd: string) => Promise<ResourceSnapshot>) {
    this.getResources = getResources
    this.commands.clear()
  }
  configureResourceDiscovery(enabled: boolean) {
    this.resourceDiscovery = enabled
    this.commands.clear()
  }
  private capabilities: ToolExecutionSettings = { codemodeEnabled: false, mcpEnabled: false }
  configureCapabilities(value: ToolExecutionSettings) {
    this.capabilities = { ...value, codemodeEnabled: value.codemodeEnabled || value.mcpEnabled }
  }
  private restrictedAccess?: SandboxCapability
  configureRestrictedAccess(capability: SandboxCapability) {
    this.restrictedAccess = { ...capability }
  }
  private defaultMode: AgentAccessMode = defaultAccessMode
  async configureDefaultAccessMode(mode: AgentAccessMode) {
    if (!isAgentAccessMode(mode)) throw new Error('Agent 访问权限无效')
    this.defaultMode = mode
    const record = this.active
    if (!record || record.sessionFile || this.hasContent(record) || record.accessMode === mode) return
    await this.switchAccessMode(record, mode)
  }
  private inlineExtensions: InlineExtension[] = []
  private mcpExtensionFactory?: (sdk: PiSdk, cwd: string) => InlineExtension
  configureMcpExtensionFactory(factory: (sdk: PiSdk, cwd: string) => InlineExtension) {
    this.mcpExtensionFactory = factory
  }
  configureInlineExtensions(extensions: InlineExtension[]) {
    this.inlineExtensions = extensions.slice()
    for (const record of this.sessions.values()) record.session.configureInlineExtensions(this.inlineExtensions)
  }
  private configureSession(record: RuntimeSession) {
    if (record.accessMode !== 'full-access' && this.restrictedAccess && !this.restrictedAccess.supported)
      throw new Error(this.restrictedAccess.reason ?? '受限权限沙箱不可用')
    record.extensionError = undefined
    record.session.configureInlineExtensions(this.inlineExtensions)
    record.session.configureCapabilities(this.capabilities)
    record.session.configureAccess(record.accessMode)
  }
  constructor(
    private initialCwd: string,
    private readonly notify: {
      connection: (value: Connection) => void
      event: (value: DesktopEvent) => void
      error: (value: DesktopError) => void
      sessionsChanged: () => void
      title?: (value: string) => void
    },
    private readonly accessStore = new AgentAccessStore(),
    private readonly runtimePaths: PiRuntimePaths = createPiRuntimePaths(
      path.join(tmpdir(), `pi-desktop-runtime-${process.pid}-${randomUUID()}`),
    ),
    private readonly credentialStorage: SecureCredentialStorage = new MemoryCredentialStorage(),
    private readonly sessionFactory: SessionFactory = (cwd, notify, paths, credentials, mcp) =>
      new SdkSession(cwd, notify, paths, credentials, mcp),
  ) {}
  private workspaceOptions?: {
    kind: (cwd: string) => WorkspaceKind
    sourceProjectCwd?: (cwd: string) => string | undefined
    createStandaloneDirectory: () => Promise<string>
  }
  configureWorkspaces(options: NonNullable<PiSessionPool['workspaceOptions']>) {
    this.workspaceOptions = options
  }
  get cwd() {
    return this.active?.cwd ?? this.initialCwd
  }
  set cwd(value: string) {
    this.initialCwd = value
  }
  connection(): Connection {
    const connection = this.active?.session.connection()
    return {
      ...(connection ?? { cwd: this.cwd, status: 'disconnected' }),
      sourceProjectCwd: this.workspaceOptions?.sourceProjectCwd?.(this.cwd),
      status: this.active?.dormant
        ? 'idle'
        : this.active?.starting
          ? 'connecting'
          : (connection?.status ?? 'disconnected'),
      error: this.active?.error ?? connection?.error,
      generation: this.generation,
      workspaceKind: this.workspaceOptions?.kind(this.cwd) ?? 'project',
      sessionKey: this.active?.key,
      accessMode: this.active?.accessMode ?? this.defaultMode,
      accessChanging: this.active?.accessChanging || this.active?.stopping,
      restrictedAccessSupported: this.restrictedAccess?.supported ?? false,
      restrictedAccessReason: this.restrictedAccess?.reason,
      sessionFile: this.active?.session.getActiveSession().sessionFile ?? this.active?.sessionFile,
      piVersion: connection?.piVersion ?? getPiVersion(),
    }
  }
  prepare(cwd: string) {
    this.stop()
    const record = this.create(cwd)
    void this.warmMetadata(record)
  }
  start(cwd: string, sessionFile?: string) {
    this.stop()
    this.localModels = null
    this.localAvailableModels = null
    this.commands.clear()
    const record = this.create(cwd, sessionFile)
    record.dormant = false
    record.accessReady = record.accessReady.then(() => {
      if (!this.sessions.has(record.key)) return
      this.configureSession(record)
      record.session.start(cwd, sessionFile)
    })
    void record.accessReady.catch(() => {})
  }
  private create(
    cwd: string,
    sessionFile?: string,
    history?: SessionHistoryData,
    inheritedMode?: AgentAccessMode,
    preservePrevious = false,
  ) {
    this.assertWorkspaceAvailable(cwd)
    if (!preservePrevious) this.discardEmpty()
    const key = `runtime:${randomUUID()}`
    const record: RuntimeSession = {
      key,
      accessMode: inheritedMode ?? this.defaultMode,
      accessReady: Promise.resolve(),
      accessChanging: false,
      stopping: false,
      cwd,
      session: null!,
      sessionFile,
      restored: Boolean(sessionFile),
      dormant: true,
      cancelledPrompt: false,
      state: {
        mode: 'default',
        model: history?.model ?? this.defaults?.model,
        // 已有会话沿用记录；新建会话留给 Pi 默认思考强度，不复制上一次的选择。
        thinkingLevel: history?.thinkingLevel ?? (sessionFile ? this.defaults?.thinkingLevel : undefined),
        sessionName: history?.sessionName,
        skillUsages: history?.skillUsages,
        recovery: history?.recovery,
        isStreaming: false,
        isCompacting: false,
        steeringMode: this.defaults?.steeringMode ?? 'one-at-a-time',
        followUpMode: this.defaults?.followUpMode ?? 'all',
        pendingMessageCount: 0,
      },
      running: false,
      pendingPrompt: false,
      settled: true,
      run: 0,
      touched: Date.now(),
      created: history?.created ?? new Date().toISOString(),
      completedAt: sessionFile ? undefined : null,
      name: history?.sessionName,
      messages: history?.messages.slice() ?? [],
      sessionEntries: history?.sessionEntries,
      branchAttachments: history?.branchAttachments?.slice(),
      stats: history?.stats,
      sequence: 0,
      executionGeneration: 0,
      liveEvents: [],
      tools: new Map(),
      extensions: new Map(),
      answers: new Set(),
      buffers: new Set(),
    }
    record.session = this.sessionFactory(
      cwd,
      {
        connection: (connection) => {
          if (!this.sessions.has(key)) return
          if (connection.status === 'disconnected') {
            const running = record.running || record.pendingPrompt
            record.pendingPrompt = false
            record.dormant = true
            record.extensions.clear()
            record.extensionError = undefined
            if (running)
              this.handleEvent(record, {
                generation: this.generation,
                executionGeneration: record.executionGeneration,
                event: {
                  type: 'agent_settled',
                  aborted: true,
                  runIntervals: record.state.runIntervals?.map((interval, index, intervals) =>
                    index === intervals.length - 1 && interval.endedAt === undefined
                      ? { ...interval, endedAt: Date.now() }
                      : interval,
                  ),
                },
              })
            record.running = false
          } else record.executionGeneration = connection.generation
          this.notify.connection(this.withSession(record.key, () => this.connection()))
          this.notify.sessionsChanged()
          if (record.session.connection().status === 'ready') this.prune()
          this.signalSettled()
        },
        event: (value) => {
          record.executionGeneration = value.executionGeneration ?? value.generation
          this.handleEvent(record, value)
        },
        error: (value) => {
          if (!this.sessions.has(key)) return
          const error = { ...value, generation: this.generation, sessionKey: key }
          if (value.extension) record.extensionError = error
          this.notify.error(error)
          this.notify.sessionsChanged()
        },
        title: (value) => {
          if (record === this.active) this.notify.title?.(value)
        },
      },
      this.runtimePaths,
      this.credentialStorage,
      this.mcpExtensionFactory,
      key,
    )
    if (sessionFile && !inheritedMode) {
      record.accessReady = this.accessStore.get(sessionFile).then((mode) => {
        record.accessMode = mode
      })
      void record.accessReady.catch(() => {})
    }
    this.sessions.set(key, record)
    this.active = record
    this.generation += 1
    this.notify.connection(this.connection())
    this.prune()
    this.notify.sessionsChanged()
    return record
  }
  private activate(record: RuntimeSession) {
    if (record !== this.active) this.discardEmpty()
    this.active = record
    record.touched = Date.now()
    this.generation += 1
    this.notify.connection(this.connection())
    this.prune()
    this.notify.sessionsChanged()
  }
  publishSessionEvent(sessionKey: string, event: DesktopEvent) {
    const record = this.sessions.get(sessionKey)
    if (record) this.handleEvent(record, event)
  }
  private handleEvent(record: RuntimeSession, value: DesktopEvent) {
    if (!this.sessions.has(record.key)) return
    const event = value.event
    if (event.type === 'agent_settled') {
      if (record.settled) return
      record.settled = true
    }
    let recordEvent: DesktopEvent = {
      ...value,
      executionGeneration: value.executionGeneration ?? value.generation,
      generation: this.generation,
      sessionKey: record.key,
      sequence: ++record.sequence,
    }
    recordEvent = this.collaboration?.decorateEvent?.(record.key, recordEvent) ?? recordEvent
    if (recordEvent.runId) record.executionRunId = recordEvent.runId
    if ('generationMetrics' in event) record.state = { ...record.state, generationMetrics: event.generationMetrics }
    for (const buffer of record.buffers) buffer.push(recordEvent)
    if ((event.type === 'agent_start' || event.type === 'agent_settled') && event.runIntervals)
      record.state = { ...record.state, runIntervals: event.runIntervals }
    if (event.type === 'agent_start') {
      record.settled = false
      record.running = true
      record.pendingPrompt = false
      this.signalSettled()
    }
    if (event.type === 'agent_settled') {
      if (record.running) record.completedAt = new Date().toISOString()
      record.running = false
      record.state = { ...record.state, isStreaming: false, isCompacting: false, activeMode: undefined }
      void this.collaboration?.settled(record.key, { ...event, runId: recordEvent.runId })
      record.liveEvents = []
      record.tools.clear()
    }
    this.rememberRecoveryEvent(record, event)
    if (event.type === 'message_start' && event.message.role === 'assistant') record.liveEvents = [recordEvent]
    if (event.type === 'message_update') record.liveEvents.push(recordEvent)
    if (event.type === 'message_end') {
      this.rememberMessage(record, event.message)
      if (event.message.role === 'assistant') record.liveEvents = []
    }
    if (event.type === 'pause_update' && event.revision >= (record.state.pauseRevision ?? 0))
      record.state = {
        ...record.state,
        isPaused: event.isPaused,
        queuePaused: event.queuePaused,
        pauseRevision: event.revision,
        pauseIntervals: event.pauseIntervals ?? record.state.pauseIntervals,
      }
    if (event.type === 'compaction_start') record.state = { ...record.state, isCompacting: true }
    if (event.type === 'compaction_end') record.state = { ...record.state, isCompacting: false }
    if (event.type === 'skill_usage_update') record.state = { ...record.state, skillUsages: event.usages }
    if (event.type === 'queue_update') record.queue = recordEvent
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update')
      record.tools.set(event.toolCallId, recordEvent)
    if (event.type === 'tool_execution_end') record.tools.delete(event.toolCallId)
    if (
      event.type === 'extension_ui_request' ||
      event.type === 'extension_ui_timeout' ||
      event.type === 'extension_ui_closed'
    )
      this.rememberExtension(record, recordEvent)
    this.notify.event(recordEvent)
    this.signalSettled()
    if (
      event.type === 'agent_start' ||
      event.type === 'agent_settled' ||
      event.type === 'message_end' ||
      event.type === 'pause_update'
    ) {
      this.notify.sessionsChanged()
      if (event.type === 'agent_settled') this.prune()
    }
  }
  private rememberRecoveryEvent(record: RuntimeSession, event: DesktopEvent['event']) {
    if (event.type === 'agent_settled') record.state = { ...record.state, recovery: event.recovery }
    if (event.type === 'agent_start' || event.type === 'recovery_start')
      record.state = { ...record.state, recovery: undefined }
    if (event.type === 'recovery_start') {
      const removed = new Set(event.removedMessageTimestamps)
      record.messages = record.messages.filter(
        (message) =>
          !(message.role === 'assistant' && message.stopReason === 'error' && removed.has(message.timestamp)),
      )
      if (record.sessionEntries)
        record.sessionEntries = {
          ...record.sessionEntries,
          entries: record.sessionEntries.entries.map((entry) =>
            entry.role === 'assistant' && entry.messageTimestamp !== undefined && removed.has(entry.messageTimestamp)
              ? { ...entry, display: false }
              : entry,
          ),
        }
      if (record.sessionFile) invalidateSessionHistory([record.sessionFile])
    }
    if (event.type === 'auto_retry_start' || event.type === 'summarization_retry_scheduled')
      record.state = {
        ...record.state,
        retry: {
          kind: event.type === 'auto_retry_start' ? 'model' : 'summary',
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage,
        },
      }
    if (
      event.type === 'agent_settled' ||
      (event.type === 'auto_retry_end' && record.state.retry?.kind === 'model') ||
      (event.type === 'summarization_retry_finished' && record.state.retry?.kind === 'summary')
    )
      record.state = { ...record.state, retry: undefined }
    if (event.type === 'agent_start' || event.type === 'compaction_start')
      record.state = { ...record.state, compactionError: undefined }
    if (event.type === 'compaction_end')
      record.state = {
        ...record.state,
        compactionError: event.aborted ? undefined : event.errorMessage,
        retry: record.state.retry?.kind === 'summary' ? undefined : record.state.retry,
      }
  }
  private rememberMessage(record: RuntimeSession, message: PiMessage) {
    const index = record.messages.findIndex((saved) => sameMessage(saved, message))
    if (index === -1) record.messages.push(message)
    else record.messages[index] = message
  }
  private rememberExtension(record: RuntimeSession, value: DesktopEvent) {
    const event = value.event as PiExtensionEvent
    if (event.type === 'extension_ui_timeout' || event.type === 'extension_ui_closed') {
      record.extensions.delete(`dialog:${event.id}`)
      return
    }
    if (['select', 'confirm', 'input', 'editor', 'questions'].includes(event.method))
      record.extensions.set(`dialog:${event.id}`, value)
    else if (event.method === 'setStatus') {
      const key = `status:${event.statusKey}`
      if (event.statusText === undefined) record.extensions.delete(key)
      else record.extensions.set(key, value)
    } else if (event.method === 'setWidget') {
      const key = `widget:${event.widgetKey}`
      if (!event.widgetLines?.length) record.extensions.delete(key)
      else record.extensions.set(key, value)
    } else if (event.method === 'setTitle') record.extensions.set('title', value)
    else if (event.method === 'set_editor_text') record.extensions.set('editor', value)
  }
  private hasContent(record: RuntimeSession) {
    return (
      record.restored ||
      record.firstMessage !== undefined ||
      record.messages.length > 0 ||
      record.pendingPrompt ||
      record.running
    )
  }
  private discardEmpty() {
    if (
      this.active &&
      this.sessions.has(this.active.key) &&
      !this.active.accessChanging &&
      !this.selectedElsewhere(this.active) &&
      !this.hasContent(this.active)
    ) {
      this.sessions.delete(this.active.key)
      this.stopRecord(this.active)
    }
  }
  private prune() {
    const idle = [...this.sessions.values()]
      .filter(
        (record) =>
          record !== this.active &&
          !this.goalSessions.has(record.key) &&
          !record.running &&
          !record.state.isPaused &&
          !record.state.queuePaused &&
          !(
            record.queue?.event.type === 'queue_update' &&
            (record.queue.event.steering.length || record.queue.event.followUp.length)
          ) &&
          record.session.connection().status === 'ready',
      )
      .sort((a, b) => b.touched - a.touched)
    for (const record of idle.slice(3)) {
      this.stopRecord(record)
      record.dormant = true
      record.extensions.clear()
      record.extensionError = undefined
    }
  }
  stop() {
    this.clearWarmup()
    this.epoch += 1
    this.selection += 1
    for (const record of this.sessions.values()) this.stopRecord(record)
    this.sessions.clear()
  }
  private async selectionResult(selection: number): Promise<SessionSelectionResult> {
    if (selection !== this.selection) return { cancelled: true }
    try {
      const snapshot = await this.snapshot()
      return selection === this.selection ? { cancelled: false, snapshot } : { cancelled: true }
    } catch (cause) {
      if (selection !== this.selection) return { cancelled: true }
      throw cause
    }
  }
  async newSession(): Promise<SessionSelectionResult> {
    if (this.changing) throw new Error('正在修改运行时配置，请稍后新建会话')
    this.assertWorkspaceAvailable(this.cwd)
    const selection = ++this.selection
    if (this.workspaceOptions?.kind(this.cwd) === 'standalone') {
      const cwd = await this.workspaceOptions.createStandaloneDirectory()
      if (selection !== this.selection) return { cancelled: true }
      this.create(cwd)
    } else if (this.hasContent(this.active)) this.create(this.cwd)
    return this.selectionResult(selection)
  }
  async selectWorkspaceDirectory(cwd: string, forceNew = false): Promise<SessionSelectionResult> {
    if (this.changing) throw new Error('正在修改运行时配置，请稍后切换项目')
    const selection = ++this.selection
    this.assertWorkspaceAvailable(cwd)
    const previous = this.active
    let target: RuntimeSession | undefined
    try {
      if (!(await stat(cwd)).isDirectory()) throw new Error('所选路径不是文件夹')
      if (selection !== this.selection) return { cancelled: true }
      if (cwd !== this.cwd || forceNew) target = this.create(cwd, undefined, undefined, undefined, true)
      const result = await this.selectionResult(selection)
      if (result.cancelled) return result
      const commands = await this.getCommands()
      if (selection !== this.selection) return { cancelled: true }
      for (const record of this.sessions.values()) {
        if (
          record !== this.active &&
          !this.selectedElsewhere(record) &&
          !record.accessChanging &&
          !this.hasContent(record)
        ) {
          this.sessions.delete(record.key)
          this.stopRecord(record)
        }
      }
      return { ...result, commands }
    } catch (cause) {
      if (selection === this.selection && target && previous) this.activate(previous)
      throw cause
    }
  }
  newSessionInDirectory(cwd: string) {
    if (this.changing) throw new Error('正在修改运行时配置，请稍后切换项目')
    this.assertWorkspaceAvailable(cwd)
    this.selection += 1
    if (cwd !== this.cwd || this.hasContent(this.active)) this.create(cwd)
    return cwd
  }
  async switchSession(sessionPath: string): Promise<SessionSelectionResult> {
    this.assertPathAvailable(sessionPath)
    if (this.changing) throw new Error('正在修改运行时配置，请稍后切换会话')
    const selection = ++this.selection
    const existing = [...this.sessions.values()].find(
      (record) =>
        record.key === sessionPath ||
        (record.sessionFile ?? record.session.getActiveSession().sessionFile) === sessionPath,
    )
    if (existing) {
      this.assertWorkspaceAvailable(existing.cwd)
      this.assertPathAvailable(existing.key)
      if (this.workspaceOptions?.kind(existing.cwd) === 'standalone') {
        try {
          if (!(await stat(existing.cwd)).isDirectory()) throw new Error('路径不是文件夹')
        } catch (cause) {
          throw new Error(`无项目会话目录不可用：${existing.cwd}；${String(cause)}`)
        }
        if (selection !== this.selection) return { cancelled: true }
      }
      if (existing !== this.active) {
        if (existing.dormant && existing.sessionFile) {
          const history = await readSessionHistory(existing.sessionFile)
          if (selection !== this.selection) return { cancelled: true }
          existing.messages = history.messages.slice()
          existing.sessionEntries = history.sessionEntries
          existing.branchAttachments = history.branchAttachments?.slice()
          existing.name = history.sessionName
          existing.state = {
            ...existing.state,
            sessionName: history.sessionName,
            skillUsages: history.skillUsages,
            recovery: history.recovery,
          }
          existing.stats = history.stats
        }
        this.assertPathAvailable(existing.key)
        this.assertWorkspaceAvailable(existing.cwd)
        this.activate(existing)
      }
    } else {
      const sessionRoot = await realpath(this.runtimePaths.sessionsDirectory).catch(() => '')
      const sessionTarget = await realpath(sessionPath).catch(() => '')
      if (!sessionRoot || !sessionTarget || !pathWithin(sessionRoot, sessionTarget))
        throw new Error('Desktop 只能打开应用内保存的会话')
      const history = await readSessionHistory(sessionPath)
      if (selection !== this.selection) return { cancelled: true }
      if (this.workspaceOptions?.kind(history.cwd) === 'standalone') {
        try {
          if (!(await stat(history.cwd)).isDirectory()) throw new Error('路径不是文件夹')
        } catch (cause) {
          throw new Error(`无项目会话目录不可用：${history.cwd}；${String(cause)}`)
        }
        if (selection !== this.selection) return { cancelled: true }
      }
      this.assertPathAvailable(sessionPath)
      this.create(history.cwd, sessionPath, history)
    }
    return this.selectionResult(selection)
  }
  getActiveSession() {
    const active = this.active.session.getActiveSession()
    return { sessionFile: active.sessionFile ?? this.active.sessionFile ?? this.active.key, sessionId: this.active.key }
  }
  getRuntimeHistory(sessionPath: string) {
    const record = this.sessions.get(sessionPath)
    return record
      ? {
          cwd: record.cwd,
          created: record.created,
          messages: record.messages,
          sessionName: record.name,
          model: record.state.model,
          thinkingLevel: record.state.thinkingLevel,
        }
      : null
  }
  getRuntimeSessions(): PiSessionSummary[] {
    return [...this.sessions.values()]
      .filter((record) => this.hasContent(record))
      .map((record) => {
        const active = record.session.getActiveSession()
        return {
          id: record.key,
          path: active.sessionFile ?? record.sessionFile ?? record.key,
          cwd: record.cwd,
          sourceProjectCwd: this.workspaceOptions?.sourceProjectCwd?.(record.cwd),
          workspaceKind: this.workspaceOptions?.kind(record.cwd) ?? 'project',
          name: record.name,
          firstMessage: record.firstMessage,
          created: record.created,
          modified: record.completedAt ?? record.created,
          completedAt: record.completedAt,
          messageCount: record.messages.length,
          running: record.running,
          isPaused: Boolean(record.state.isPaused),
          error: record.error ?? record.session.connection().error,
        }
      })
  }
  async snapshot(): Promise<Snapshot> {
    const record = this.active
    // 当前会话被删掉后，视图可能仍指向旧 key，这里不能再读 accessReady。
    if (!record) throw new Error('当前查看的会话已更换')
    const generation = this.generation
    await record.accessReady
    if (record !== this.active || generation !== this.generation) throw new Error('当前查看的会话已更换')
    const events = [
      ...record.liveEvents,
      ...record.tools.values(),
      ...(record.queue ? [record.queue] : []),
      ...record.extensions.values(),
    ]
    const projection = async (): Promise<Snapshot> => {
      await this.warmMetadata(record)
      const models = this.localAvailableModels ?? []
      if (this.localAvailableModels && record.state.model) {
        record.state.modelSelectionRequired = !models.some(
          (model) => model.provider === record.state.model?.provider && model.id === record.state.model?.id,
        )
      }
      return {
        connection: this.connection(),
        extensionError: record.extensionError ? { ...record.extensionError, generation } : undefined,
        state: { ...record.state, isStreaming: record.running },
        messages: record.messages,
        sessionEntries: record.sessionEntries,
        branchAttachments: record.branchAttachments,
        models,
        thinkingLevels: this.thinkingLevels,
        stats: record.stats,
        events: [
          ...record.liveEvents,
          ...record.tools.values(),
          ...(record.queue ? [record.queue] : []),
          ...record.extensions.values(),
        ].map((event) => ({ ...event, generation })),
        eventSequence: record.sequence,
      }
    }
    if (record.dormant || record.starting) return projection()
    const buffer: DesktopEvent[] = []
    record.buffers.add(buffer)
    try {
      const snapshot = await record.session.snapshot()
      if (record !== this.active || generation !== this.generation) throw new Error('当前查看的会话已更换')
      this.rememberSnapshot(record, snapshot)
      if (record.sessionFile && !record.accessChanging)
        await this.accessStore.set(record.sessionFile, record.accessMode)
      for (const value of buffer) {
        if (value.event.type === 'message_end') this.rememberMessage(record, value.event.message)
        this.rememberRecoveryEvent(record, value.event)
      }
      if (!buffer.some((value) => value.event.type === 'agent_start' || value.event.type === 'agent_settled'))
        record.running =
          (!record.settled && record.pendingPrompt) ||
          snapshot.state.isStreaming ||
          snapshot.state.isCompacting ||
          Boolean(record.state.retry)
      return {
        ...snapshot,
        extensionError: record.extensionError ? { ...record.extensionError, generation } : undefined,
        state: {
          ...snapshot.state,
          mode: record.state.mode,
          isPaused: record.state.isPaused,
          queuePaused: record.state.queuePaused,
          pauseRevision: record.state.pauseRevision,
          pauseIntervals: record.state.pauseIntervals,
          runIntervals: record.state.runIntervals,
          retry: record.state.retry,
          recovery: record.state.recovery,
          compactionError: record.state.compactionError,
          isStreaming: record.running,
          isCompacting: record.running && snapshot.state.isCompacting,
        },
        connection: this.connection(),
        events: [...events, ...buffer].map((event) => ({ ...event, generation })),
        eventSequence: record.sequence,
      }
    } catch (cause) {
      if (record === this.active && generation === this.generation && record.dormant) return projection()
      throw cause
    } finally {
      record.buffers.delete(buffer)
    }
  }
  private async warmMetadata(record: RuntimeSession) {
    const epoch = this.epoch
    try {
      const models = await (this.localModels ??= readLocalModels(this.runtimePaths.agentDir, this.credentialStorage))
      if (epoch !== this.epoch) return
      this.localAvailableModels ??= models
      const target = this.sessions.has(record.key) ? record : this.active
      if (!target || !this.sessions.has(target.key)) return
      const preferences = await readLocalPreferences(target.cwd, this.runtimePaths.agentDir)
      if (epoch !== this.epoch || !this.sessions.has(target.key)) return
      if (!target.state.model && !target.sessionFile) {
        target.state.model =
          models.find((model) => model.id === preferences.modelId && model.provider === preferences.provider) ??
          models[0]
      }
      if (!target.sessionFile && target.state.thinkingLevel == null) {
        const model = target.state.model
        const perModel = model ? preferences.modelThinkingLevels[`${model.provider}/${model.id}`] : undefined
        const level = perModel ?? preferences.thinkingLevel
        if (level) target.state.thinkingLevel = level
      }
    } catch (cause) {
      if (record === this.active && this.sessions.has(record.key))
        this.notify.error({
          generation: this.generation,
          sessionKey: record.key,
          message: `无法读取本地模型配置：${String(cause)}`,
        })
    }
  }
  private rememberSnapshot(record: RuntimeSession, snapshot: Snapshot) {
    if (snapshot.stats) record.stats = snapshot.stats
    record.name = snapshot.state.sessionName
    const pauseState =
      (record.state.pauseRevision ?? 0) > (snapshot.state.pauseRevision ?? 0) ||
      ((record.state.pauseRevision ?? 0) === (snapshot.state.pauseRevision ?? 0) &&
        (record.state.pauseIntervals?.at(-1)?.endedAt ?? 0) > (snapshot.state.pauseIntervals?.at(-1)?.endedAt ?? 0))
        ? {
            isPaused: record.state.isPaused,
            queuePaused: record.state.queuePaused,
            pauseRevision: record.state.pauseRevision,
            pauseIntervals: record.state.pauseIntervals,
          }
        : {}
    record.state = {
      ...snapshot.state,
      ...pauseState,
      runIntervals:
        (record.state.runIntervals?.length ?? 0) > (snapshot.state.runIntervals?.length ?? 0) ||
        ((record.state.runIntervals?.length ?? 0) === (snapshot.state.runIntervals?.length ?? 0) &&
          ((record.state.runIntervals?.at(-1)?.startedAt ?? 0) >
            (snapshot.state.runIntervals?.at(-1)?.startedAt ?? 0) ||
            (record.state.runIntervals?.at(-1)?.endedAt ?? 0) > (snapshot.state.runIntervals?.at(-1)?.endedAt ?? 0)))
          ? record.state.runIntervals
          : snapshot.state.runIntervals,
      mode: record.state.mode,
    }
    record.messages = snapshot.messages.slice()
    record.sessionEntries = snapshot.sessionEntries
    record.branchAttachments = snapshot.branchAttachments?.slice()
    record.sessionFile = record.session.getActiveSession().sessionFile ?? record.sessionFile
    if (record !== this.active) return
    this.defaults = {
      model: snapshot.state.model,
      thinkingLevel: snapshot.state.thinkingLevel,
      steeringMode: snapshot.state.steeringMode,
      followUpMode: snapshot.state.followUpMode,
    }
    this.localAvailableModels = snapshot.models
    this.thinkingLevels = snapshot.thinkingLevels ?? []
  }
  private async ensureRuntime(record: RuntimeSession, executionMode?: TaskMode): Promise<void> {
    // 已预约的消息先运行；随后登记的退役会等待它结束，不能反过来等待退役。
    if (!record.pendingPrompt) await record.retiring
    this.checkoutGate?.(record.cwd)
    if (record.starting) return record.starting
    if (record.session.connection().status === 'ready') return Promise.resolve()
    record.dormant = false
    const starting = (async () => {
      await record.accessReady
      this.configureSession(record)
      await record.session.setSessionMode(executionMode ?? record.state.mode)
      await record.session.reconnectModels({
        sessionFile: record.sessionFile,
        model: record.state.model,
        thinkingLevel: record.state.thinkingLevel,
      })
      if (record.name && !record.sessionFile) await record.session.setSessionName(record.name)
      if (record.state.steeringMode) await record.session.setSteeringMode(record.state.steeringMode)
      if (record.state.followUpMode) await record.session.setFollowUpMode(record.state.followUpMode)
      const snapshot = await record.session.snapshot()
      this.rememberSnapshot(record, snapshot)
      if (record.sessionFile) await this.accessStore.set(record.sessionFile, record.accessMode)
      if (!this.sessions.has(record.key)) return
      this.commands.set(`${record.cwd}:${record.accessMode}`, await record.session.getCommands())
      this.notify.sessionsChanged()
    })()
    record.starting = starting
    return starting.finally(() => {
      record.starting = undefined
      if (record.session.connection().status === 'disconnected') record.dormant = true
      this.signalSettled()
      if (this.sessions.has(record.key)) this.notify.connection(this.withSession(record.key, () => this.connection()))
    })
  }
  async idle<T>(action: () => Promise<T>, allowDisconnected = false): Promise<T> {
    if (
      this.changing ||
      this.deletingCwds.size > 0 ||
      this.mutatingPaths.size > 0 ||
      [...this.sessions.values()].some(
        (record) => record.running || record.accessChanging || record.starting || record.stopping,
      )
    )
      throw new Error('有会话正在运行，请停止后再修改运行时配置')
    this.changing = true
    try {
      await Promise.all(
        [...this.sessions.values()].map((record) =>
          record.session.assertIdle(record !== this.active || allowDisconnected || record.dormant),
        ),
      )
      if ([...this.sessions.values()].some((record) => record.running))
        throw new Error('有会话正在运行，请停止后再修改运行时配置')
      return await action()
    } finally {
      this.changing = false
    }
  }
  private target(sessionKey: string) {
    if (this.changing) throw new Error('正在修改运行时配置，请稍后操作会话')
    const record = this.sessions.get(sessionKey)
    if (!record) throw new Error('目标会话已关闭，请重新打开后发送')
    this.checkoutGate?.(record.cwd)
    this.assertWorkspaceAvailable(record.cwd)
    this.assertPathAvailable(record.key)
    this.assertPathAvailable(this.recordPath(record))
    if (record.accessChanging) throw new Error('正在更新 Agent 访问权限，请稍后操作')
    return record
  }
  async setAccessMode(sessionKey: string, mode: AgentAccessMode) {
    if (!isAgentAccessMode(mode)) throw new Error('Agent 访问权限无效')
    const record = this.target(sessionKey)
    await this.switchAccessMode(record, mode)
  }

  private async switchAccessMode(record: RuntimeSession, mode: AgentAccessMode) {
    if (
      record.running ||
      record.pendingPrompt ||
      record.starting ||
      record.stopping ||
      record.session.connection().status === 'connecting'
    )
      throw new Error('任务结束后可切换权限')
    if (mode !== 'full-access' && !this.restrictedAccess?.supported)
      throw new Error(this.restrictedAccess?.reason ?? '受限权限沙箱不可用')
    record.accessChanging = true
    this.notify.connection(this.withSession(record.key, () => this.connection()))
    try {
      await record.accessReady
      if (record.session.connection().status === 'connecting') throw new Error('任务结束后可切换权限')
      if (record.accessMode === mode) return
      await record.session.idle(async () => {
        if (record.session.connection().status === 'ready')
          this.rememberSnapshot(record, await record.session.snapshot())
        await record.session.stopAndWait()
        record.dormant = true
        record.extensions.clear()
        record.extensionError = undefined
        if (record.sessionFile) await this.accessStore.set(record.sessionFile, mode)
        if (!this.sessions.has(record.key)) throw new Error('目标会话已关闭')
        record.accessMode = mode
        this.commands.delete(`${record.cwd}:${record.accessMode}`)
        this.handleEvent(record, {
          generation: this.generation,
          executionGeneration: record.session.connection().generation,
          event: { type: 'access_mode_changed', mode },
        })
      }, true)
    } finally {
      record.accessChanging = false
      this.signalSettled()
      this.notify.connection(this.withSession(record.key, () => this.connection()))
    }
  }
  async editAndPrompt(
    sessionKey: string,
    timestamp: number,
    message: string,
    images?: PiImage[],
    skills: SkillReference[] = [],
    options?: MessageOptions,
  ) {
    const record = this.target(sessionKey)
    await this.prompt(sessionKey, message, images, skills, options, undefined, timestamp)
    const { entries } = await record.session.getEntries()
    const first = entries.find((entry) => messageEntry(entry) && entry.message.role === 'user')
    if (first && messageEntry(first) && first.message.role === 'user') {
      const content = first.message.content
      record.firstMessage =
        typeof content === 'string'
          ? content
          : content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n')
      this.notify.sessionsChanged()
    }
  }
  async forkReply(sessionKey: string, userTimestamp: number): Promise<SessionSelectionResult> {
    const source = this.target(sessionKey)
    if (source.running || this.changing) throw new Error('会话正在运行，请等待完成后新建会话')
    this.changing = true
    const temporary = this.sessionFactory(
      source.cwd,
      {
        connection: () => {},
        event: () => {},
        error: () => {},
      },
      this.runtimePaths,
      this.credentialStorage,
      this.mcpExtensionFactory,
    )
    try {
      if (source.dormant) await this.ensureRuntime(source)
      const sourcePath = source.session.getActiveSession().sessionFile ?? source.sessionFile
      if (!sourcePath) throw new Error('会话尚未保存，等它完成一轮对话后再新建会话')
      const data = await source.session.getEntries()
      const path = activePath(data.entries, data.leafId)
      const userIndex = path.findIndex(
        (entry) => messageEntry(entry) && entry.message.role === 'user' && entry.message.timestamp === userTimestamp,
      )
      if (userIndex === -1) throw new Error('找不到这条对话，请刷新会话后重试')
      const nextUser = path.slice(userIndex + 1).find((entry) => messageEntry(entry) && entry.message.role === 'user')
      const forkPoint = nextUser?.parentId ?? data.leafId
      if (!forkPoint) throw new Error('这段对话还没有可分叉的回复')
      const throughPoint = path.slice(0, path.findIndex((entry) => entry.id === forkPoint) + 1)
      const pendingCalls = new Set<string>()
      for (const entry of throughPoint) {
        if (!messageEntry(entry)) continue
        if (entry.message.role === 'assistant' && Array.isArray(entry.message.content)) {
          for (const part of entry.message.content) if (part.type === 'toolCall') pendingCalls.add(part.id)
        }
        if (entry.message.role === 'toolResult') pendingCalls.delete(entry.message.toolCallId)
      }
      if (pendingCalls.size) throw new Error('这段回复的工具结果尚未保存，暂时无法新建会话')

      temporary.configureInlineExtensions(this.inlineExtensions)
      temporary.configureCapabilities(this.capabilities)
      temporary.configureAccess(source.accessMode)
      temporary.start(source.cwd, sourcePath)
      await temporary.getEntries()
      const result = await temporary.forkAtEntry(forkPoint)
      if (result.cancelled) return { cancelled: true }
      await temporary.snapshot()
      const forkedPath = temporary.getActiveSession().sessionFile
      if (!forkedPath || forkedPath === sourcePath) throw new Error('Pi 没有创建新的会话文件')
      const history = await readSessionHistory(forkedPath)
      const selection = ++this.selection
      await this.accessStore.set(forkedPath, source.accessMode)
      this.create(history.cwd, forkedPath, history, source.accessMode)
      return await this.selectionResult(selection)
    } finally {
      temporary.stop()
      this.changing = false
    }
  }
  async prompt(
    sessionKey: string,
    message: string,
    images?: PiImage[],
    skills: SkillReference[] = [],
    options?: MessageOptions,
    goalControl?: GoalControl,
    editTimestamp?: number,
    recoveryEntryId?: string,
  ) {
    const normalized = normalizePlanMessage(message, options?.mode ?? this.target(sessionKey).state.mode)
    if (editTimestamp !== undefined && (normalized.commandOnly || builtinCommand(normalized.text)))
      throw new Error('编辑消息需要重新发送正文，不能执行内置命令')
    if (normalized.commandOnly) {
      await this.setSessionMode(sessionKey, normalized.mode)
      return
    }
    message = normalized.text
    const record = this.target(sessionKey)
    if (this.changing || record.running) throw new Error('当前会话正在运行或修改配置，请稍后发送')
    await record.retiring
    this.target(sessionKey)
    if (this.changing || record.running) throw new Error('当前会话正在运行或修改配置，请稍后发送')
    if (recoveryEntryId && (!this.isSessionIdle(sessionKey) || record.state.recovery?.entryId !== recoveryEntryId))
      throw new Error('当前失败已失效或会话正在运行，请重新读取状态')
    const run = ++record.run
    record.settled = false
    record.cancelledPrompt = false
    record.error = undefined
    record.pendingPrompt = true
    record.running = true
    record.touched = Date.now()
    if (!goalControl && !recoveryEntryId && !record.restored && !builtinCommand(message))
      record.firstMessage ||= message
    this.notify.sessionsChanged()
    try {
      if (!recoveryEntryId) await this.setSessionMode(sessionKey, normalized.mode)
      await this.ensureRuntime(record, normalized.mode)
      if (record.cancelledPrompt || !this.sessions.has(record.key)) throw new Error('消息发送已取消')
      await this.collaboration?.beforePrompt(sessionKey, { mode: normalized.mode, message })
      if (record.cancelledPrompt || !this.sessions.has(record.key)) throw new Error('消息发送已取消')
      record.state.activeMode = normalized.mode
      const result = recoveryEntryId
        ? await record.session.recover(recoveryEntryId)
        : goalControl
          ? await record.session.continueGoalTask(message, goalControl)
          : await record.session.prompt(
              message,
              images,
              skills,
              { mode: normalized.mode, clientProcessingAudit: options?.clientProcessingAudit },
              false,
              true,
              undefined,
              editTimestamp,
            )
      await record.session.setSessionMode(record.state.mode)
      return result
    } catch (cause) {
      if (!this.sessions.has(record.key)) throw cause
      // 失败只通知当前客户端。写进连接状态的话，之后每次刷新都会把同一条错误再显示出来。
      const message = String(cause)
      void this.collaboration?.failed(sessionKey, cause, record.executionRunId)
      this.notify.error({ generation: this.generation, sessionKey: record.key, message })
      record.running = false
      this.notify.sessionsChanged()
      void record.session
        .snapshot()
        .then((snapshot) => {
          if (!this.sessions.has(record.key) || run !== record.run) return
          if (recoveryEntryId) this.rememberSnapshot(record, snapshot)
          record.running = snapshot.state.isStreaming || snapshot.state.isCompacting
          if (!record.running)
            this.handleEvent(record, {
              generation: this.generation,
              executionGeneration: record.session.connection().generation,
              event: { type: 'agent_settled', recovery: snapshot.state.recovery },
            })
          this.notify.sessionsChanged()
        })
        .catch(() => {
          if (!this.sessions.has(record.key) || run !== record.run) return
          if (record.session.connection().status === 'disconnected') {
            record.running = false
            record.dormant = true
            this.handleEvent(record, {
              generation: this.generation,
              executionGeneration: record.session.connection().generation,
              event: { type: 'agent_settled' },
            })
          }
          this.notify.sessionsChanged()
        })
      throw cause
    } finally {
      record.pendingPrompt = false
      if (record.settled) record.running = false
      this.signalSettled()
    }
  }
  recover(sessionKey: string, failureEntryId: string) {
    const record = this.target(sessionKey)
    const recovery = record.state.recovery
    if (!this.isSessionIdle(sessionKey) || !recovery || recovery.entryId !== failureEntryId)
      throw new Error('当前失败已失效或会话正在运行，请重新读取状态')
    return this.prompt(
      sessionKey,
      recoveryMessage,
      undefined,
      [],
      { mode: recovery.mode },
      undefined,
      undefined,
      failureEntryId,
    )
  }
  continueGoalTask(key: string, message: string, control: GoalControl) {
    return this.prompt(key, message, undefined, [], { mode: 'default' }, control)
  }
  async steer(
    sessionKey: string,
    message: string,
    images?: PiImage[],
    skills?: SkillReference[],
    options?: MessageOptions,
  ) {
    const record = this.target(sessionKey)
    if (record.session.connection().status !== 'ready') {
      await this.ensureRuntime(record, options?.mode)
      if (this.isSessionIdle(sessionKey)) return this.prompt(sessionKey, message, images, skills, options)
    }
    return record.session.steer(message, images, skills, options)
  }
  async followUp(
    sessionKey: string,
    message: string,
    images?: PiImage[],
    skills?: SkillReference[],
    options?: MessageOptions,
  ) {
    const record = this.target(sessionKey)
    if (record.session.connection().status !== 'ready') {
      await this.ensureRuntime(record, options?.mode)
      if (this.isSessionIdle(sessionKey)) return this.prompt(sessionKey, message, images, skills, options)
    }
    return record.session.followUp(message, images, skills, options)
  }
  getRuntimeSession(sessionKey: string) {
    return this.target(sessionKey).session
  }
  getSessionContext(sessionKey: string) {
    const record = this.target(sessionKey)
    return {
      sessionKey,
      cwd: record.cwd,
      state: record.state,
      accessMode: record.accessMode,
      sessionFile: record.sessionFile,
      sessionId: record.session.getActiveSession().sessionId ?? record.stats?.sessionId,
    }
  }
  readSessionBinding(sessionKey: string) {
    const record = this.sessions.get(sessionKey)
    if (!record) throw new Error('目标会话已关闭，请重新打开后发送')
    return {
      sessionKey,
      cwd: record.cwd,
      state: { ...record.state },
      accessMode: record.accessMode,
      sessionFile: record.sessionFile,
      sessionId: record.session.getActiveSession().sessionId ?? record.stats?.sessionId,
      session: record.session,
      modeRevision: record.modeRevision ?? 0,
    }
  }
  restoreSessionMode(sessionKey: string, mode: TaskMode, expected: { mode: TaskMode; revision: number }) {
    const record = this.sessions.get(sessionKey)
    if (!record) throw new Error('目标会话已关闭，请重新打开后发送')
    if (record.state.mode === expected.mode && (record.modeRevision ?? 0) === expected.revision)
      record.state = { ...record.state, mode }
    return record.state.mode
  }
  async setSessionMode(sessionKey: string, mode: TaskMode) {
    const record = this.target(sessionKey)
    const revision = (record.modeRevision = (record.modeRevision ?? 0) + 1)
    record.state = { ...record.state, mode }
    await this.collaboration?.modeChanged?.(sessionKey, mode)
    if (record.modeRevision !== revision) return
    if (!record.dormant && !record.pendingPrompt) await record.session.setSessionMode(mode)
  }
  abort(sessionKey: string) {
    const pending = this.aborts.get(sessionKey)
    if (pending) return pending
    const stopping = Promise.resolve().then(() => this.abortSession(sessionKey))
    this.aborts.set(sessionKey, stopping)
    void stopping
      .finally(() => {
        if (this.aborts.get(sessionKey) === stopping) this.aborts.delete(sessionKey)
      })
      .catch(() => {})
    return stopping
  }
  private async abortSession(sessionKey: string) {
    const record = this.target(sessionKey)
    record.stopping = true
    this.notify.connection(this.withSession(record.key, () => this.connection()))
    try {
      await this.collaboration?.stop(sessionKey)
      if (record.pendingPrompt && record.starting) {
        record.cancelledPrompt = true
        await record.starting.catch(() => {})
        return
      }
      await record.session.abort()
      if (record.running && this.sessions.has(record.key))
        this.handleEvent(record, {
          generation: this.generation,
          executionGeneration: record.session.connection().generation,
          event: { type: 'agent_settled' },
        })
    } finally {
      record.stopping = false
      this.signalSettled()
      this.notify.connection(this.withSession(record.key, () => this.connection()))
    }
  }
  pause(sessionKey: string) {
    return this.collaboration?.pause ? this.collaboration.pause(sessionKey) : this.target(sessionKey).session.pause()
  }
  resume(sessionKey: string) {
    return this.collaboration?.resume ? this.collaboration.resume(sessionKey) : this.target(sessionKey).session.resume()
  }
  async steerQueueInput(sessionKey: string, id: string) {
    const record = this.target(sessionKey)
    await record.session.steerQueueInput(id)
    if (record.state.isPaused || record.state.queuePaused) await this.resume(sessionKey)
  }
  deleteQueueInput(sessionKey: string, id: string) {
    return this.target(sessionKey).session.deleteQueueInput(id)
  }
  private queueOwner() {
    const clientId = this.viewContext.getStore()?.clientId
    if (!clientId) throw new Error('排队编辑缺少客户端身份')
    return clientId
  }
  beginQueueEdit(sessionKey: string, id: string) {
    return this.target(sessionKey).session.beginQueueEdit(id, this.queueOwner())
  }
  updateQueueInput(
    sessionKey: string,
    id: string,
    message: string,
    images?: PiImage[],
    skills?: SkillReference[],
    options?: MessageOptions,
  ) {
    return this.target(sessionKey).session.updateQueueInput(id, message, images, skills, options, this.queueOwner())
  }
  cancelQueueEdit(sessionKey: string, id: string) {
    return this.target(sessionKey).session.cancelQueueEdit(id, this.queueOwner())
  }
  async releaseQueueEdits(clientId: string) {
    await Promise.all(
      [...this.sessions.values()]
        .filter(
          (record) =>
            record.queue?.event.type === 'queue_update' &&
            [...record.queue.event.steering, ...record.queue.event.followUp].some((input) => input.editing),
        )
        .map((record) => record.session.releaseQueueEdits(clientId)),
    )
  }

  clearQueue(sessionKey: string) {
    return this.target(sessionKey).session.clearQueue()
  }
  async setSteeringMode(sessionKey: string, mode: 'all' | 'one-at-a-time') {
    const record = this.target(sessionKey)
    record.state = record.dormant ? { ...record.state, steeringMode: mode } : await record.session.setSteeringMode(mode)
    return record.state
  }
  async setFollowUpMode(sessionKey: string, mode: 'all' | 'one-at-a-time') {
    const record = this.target(sessionKey)
    record.state = record.dormant ? { ...record.state, followUpMode: mode } : await record.session.setFollowUpMode(mode)
    return record.state
  }
  async getCommands() {
    const record = this.active
    if (record.dormant || record.starting) {
      const snapshot = this.resourceDiscovery ? await this.getResources?.(record.cwd) : undefined
      const commands = snapshot ? readLocalSkills(snapshot) : []
      this.commands.set(`${record.cwd}:${record.accessMode}`, commands)
      return [...builtinCommands, ...commands]
    }
    const commands = (await record.session.getCommands()).filter((command) => !command.name.startsWith('pi-desktop-'))
    this.commands.set(`${record.cwd}:${record.accessMode}`, commands)
    return [...builtinCommands, ...commands]
  }
  async setModel(sessionKey: string, model: PiModel) {
    const record = this.target(sessionKey)
    if (record.dormant) {
      const models =
        this.localAvailableModels ??
        (await (this.localModels ??= readLocalModels(this.runtimePaths.agentDir, this.credentialStorage)))
      const selected = models.find((entry) => entry.id === model.id && entry.provider === model.provider) ?? model
      record.state = { ...record.state, model: selected, modelSelectionRequired: false }
      return selected
    }
    const selected = await record.session.setModel(model)
    record.state.model = selected
    return selected
  }
  async setThinkingLevel(sessionKey: string, level: ThinkingLevel) {
    const record = this.target(sessionKey)
    if (record.dormant) {
      record.state = { ...record.state, thinkingLevel: level }
      return
    }
    await record.session.setThinkingLevel(level)
    record.state.thinkingLevel = level
  }
  getAvailableThinkingLevels() {
    return this.active.dormant ? Promise.resolve(this.thinkingLevels) : this.active.session.getAvailableThinkingLevels()
  }
  getSessionStats() {
    if (this.active.dormant) {
      return this.active.stats
        ? Promise.resolve(this.active.stats)
        : Promise.reject(new Error('会话尚未运行，暂无上下文统计'))
    }
    return this.active.session.getSessionStats()
  }
  captureRestoreState() {
    if (this.active.dormant)
      return Promise.resolve({
        sessionFile: this.active.sessionFile,
        model: this.active.state.model,
        thinkingLevel: this.active.state.thinkingLevel,
      })
    return this.active.session.captureRestoreState()
  }
  private async restoreRuntime(restore: ModelRestore | undefined) {
    const record = this.active
    const epoch = ++this.epoch
    const retained = [...this.sessions.values()]
    await Promise.all(
      retained.map(async (entry) => {
        if (entry.session.connection().status === 'ready') {
          this.rememberSnapshot(entry, await entry.session.snapshot())
        }
      }),
    )
    this.localModels = null
    this.localAvailableModels = null
    this.thinkingLevels = [...thinkingLevels]
    this.commands.clear()
    for (const entry of retained) {
      this.stopRecord(entry)
      entry.dormant = entry !== record
      entry.extensions.clear()
      entry.extensionError = undefined
      entry.liveEvents = []
      entry.tools.clear()
      entry.queue = undefined
    }
    this.generation += 1
    record.error = undefined
    this.checkoutGate?.(record.cwd)
    const starting = Promise.resolve().then(async () => {
      await record.accessReady
      this.configureSession(record)
      await record.session.setSessionMode(record.state.mode)
      await record.session.reconnectModels(
        restore ?? {
          sessionFile: record.sessionFile,
          model: record.state.model,
          thinkingLevel: record.state.thinkingLevel,
        },
      )
      if (epoch !== this.epoch || !this.sessions.has(record.key)) return
      if (record.session.connection().status !== 'ready') return
      await record.session.setSessionMode(record.state.mode)
      await record.session.setSteeringMode(record.state.steeringMode)
      await record.session.setFollowUpMode(record.state.followUpMode)
      this.rememberSnapshot(record, await record.session.snapshot())
    })
    record.starting = starting
    this.notify.connection(this.connection())
    try {
      await starting
    } finally {
      record.starting = undefined
      this.signalSettled()
      if (epoch === this.epoch && this.sessions.has(record.key)) {
        record.dormant = record.session.connection().status !== 'ready'
        this.notify.connection(this.connection())
        this.notify.sessionsChanged()
      }
    }
  }
  reconnectModels(restore?: ModelRestore) {
    return this.restoreRuntime(restore)
  }
  async respondExtensionUI(sessionKey: string, id: string, response: PiExtensionUIResponse) {
    const record = this.target(sessionKey)
    const saved = record.extensions.get(`dialog:${id}`)
    if (!saved || record.answers.has(id)) throw new Error('交互已回答或已过期')
    const request = saved.event
    if (request.type !== 'extension_ui_request') throw new Error('扩展交互请求无效')
    validateExtensionDialogResponse(request as import('@pi-meme/contracts/pi').PiExtensionDialogRequest, response)
    const executionGeneration = saved.executionGeneration ?? saved.generation
    record.answers.add(id)
    try {
      await record.session.respondExtensionUI(id, response)
      this.handleEvent(record, {
        generation: this.generation,
        executionGeneration,
        event: { type: 'extension_ui_closed', id, reason: 'answered' },
      })
    } catch (cause) {
      if (record.session.connection().status === 'disconnected' || /已取消|超时|过期/.test(String(cause)))
        this.handleEvent(record, {
          generation: this.generation,
          executionGeneration,
          event: { type: 'extension_ui_closed', id, reason: 'cancelled' },
        })
      throw cause
    } finally {
      record.answers.delete(id)
      this.signalSettled()
    }
  }
}
