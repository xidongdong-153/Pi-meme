import type { GoalControl } from '@pi-meme/contracts/goal'
import { validateExtensionDialogResponse } from '@pi-meme/contracts/user-input'
import {
  normalizePlanMessage,
  type TaskMode,
  type MessageOptions,
  type PromptReceipt,
  type MessageConfiguration,
  type EditMessageOptions,
  type EditMessageResult,
  type QueuedInput,
} from '@pi-meme/contracts/plan'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ToolExecutionSettings } from '@pi-meme/contracts/settings'
import type { InlineExtension, PromptTemplate } from '@earendil-works/pi-coding-agent'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  defaultAccessMode,
  effectiveAgentAccess,
  isAgentAccessMode,
  type AgentAccessMode,
} from '@pi-meme/contracts/agent-access'
import { AgentAccessStore } from './access-store'
import type {
  PiExtensionEvent,
  PiExtensionUIResponse,
  PiMessage,
  PiImage,
  PiModel,
  PiSessionEntry,
  PiSlashCommand,
  PiState,
  SessionThinkingLevel,
  SessionExecutionPhase,
  ServiceTier,
} from '@pi-meme/contracts/pi'
import {
  builtinCommand,
  builtinCommands,
  sameMessage,
  updateModelServiceTier,
  validateServiceTier,
  modelThinkingLevels,
  isSessionThinkingLevel,
  resolveModelThinkingLevel,
  resolveSessionThinkingLevel,
  resolveThinkingLevel,
} from '@pi-meme/contracts/pi'
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
import {
  explicitSessionName,
  projectSessionActivity,
  type SessionWindow,
  type PiSessionSummary,
  type WorkspaceKind,
} from '@pi-meme/contracts/sessions'
import { AccessSandbox, type SandboxCapability } from './sdk/access-sandbox'
import { SdkSession } from './sdk/session'
import { recoveryMessage } from './sdk/recovery'
import { getPiVersion, loadPiSdk } from './sdk/load'
import type { ModelRestore, PiRuntime } from './runtime'
import { invalidateSessionHistory, readSessionHistory, type SessionHistoryData } from './session-history'
import { markHistoryAppend, removeHistoryIndexes } from './session-history-index'
import { projectSessionWindow, projectSessionDetails } from '@pi-meme/contracts/session-window'
import { projectBranchEntries } from './session-tree-entries'
import { defaultModelConfiguration, readLocalModels, readLocalPreferences, readLocalSkills } from './session-metadata'
import { appendServiceTier, serviceTierEntry } from './session-service-tier'
import { appendSessionThinkingSelection, projectSessionThinkingLevel, sessionThinkingEntry } from './session-thinking'
import { createPiRuntimePaths, createTemporaryRuntimePaths, type PiRuntimePaths } from './runtime-paths'
import { MemoryCredentialStorage } from './secure-store'
import {
  generateSessionTitle,
  SessionTitleRequests,
  sessionTitlePrompt,
  suggestedTitlePrompt,
  titleUserText,
} from './session-title'

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

function forkAgentIds(entries: readonly PiSessionEntry[]) {
  const ids = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value === 'string' && value) ids.add(value)
  }
  const read = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const details = value as {
      agentId?: unknown
      fromAgentId?: unknown
      agent?: { agentId?: unknown }
      agents?: Array<{ agentId?: unknown }>
    }
    add(details.agentId)
    add(details.fromAgentId)
    add(details.agent?.agentId)
    for (const agent of details.agents ?? []) add(agent?.agentId)
  }
  for (const entry of entries) {
    if ((entry.type === 'custom_message' || entry.type === 'custom') && entry.customType === 'pi-meme-collaboration')
      read(entry.type === 'custom_message' ? entry.details : entry.data)
    if (entry.type === 'message' && entry.message.role === 'toolResult') read(entry.message.details)
  }
  return [...ids]
}

function pathWithin(root: string, value: string) {
  const relative = path.relative(path.resolve(root), path.resolve(value))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

type RuntimeSession = {
  retained?: boolean
  key: string
  temporary?: boolean
  temporaryRoot?: string
  accessMode: AgentAccessMode
  accessReady: Promise<void>
  accessChanging: boolean
  stopping: boolean
  cwd: string
  session: RuntimeSdkSession
  sessionFile?: string
  sessionStartEvent?: ModelRestore['sessionStartEvent']
  restored: boolean
  dormant: boolean
  starting?: Promise<void>
  retiring?: Promise<void>
  workerStopping?: Promise<void>
  cancelledPrompt: boolean
  error?: string
  extensionError?: DesktopError
  state: PiState
  queueModes?: Partial<Pick<PiState, 'steeringMode' | 'followUpMode'>>
  phase: SessionExecutionPhase
  phaseRevision: number
  readonly running: boolean
  readonly pendingPrompt: boolean
  snapshotRequest: number
  acceptedSnapshot: number
  run: number
  touched: number
  created: string
  name?: string
  completedAt?: string | null
  firstMessage?: string
  awaitingTitleInput: boolean
  messages: PiMessage[]
  totalMessages?: number
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
  activityBySession?: () => Map<string, { runningChild: boolean; inputRequestIds: string[] }>
  pause?: (sessionKey: string) => Promise<void>
  resume?: (sessionKey: string) => Promise<void>
  modeChanged?: (sessionKey: string, mode: TaskMode) => Promise<void>
  beforePolicyChange?: (sessionKey: string, access: AgentAccessMode, mode: TaskMode) => Promise<void>
  beforeExecution?: (sessionKey: string, access: AgentAccessMode, mode: TaskMode) => Promise<void>
  decorateEvent?: (sessionKey: string, event: DesktopEvent) => DesktopEvent
  beforePrompt: (sessionKey: string, input: { mode: TaskMode; message: string }) => Promise<void>
  beforeEdit?: (sessionKey: string) => Promise<void>
  beforeFork?: (sessionKey: string, agentIds: readonly string[]) => Promise<void>
  forked?: (sourceSessionKey: string, forkedSessionKey: string, agentIds: readonly string[]) => Promise<void>
  settled: (sessionKey: string, event: { aborted?: boolean; runId?: string }) => void | Promise<void>
  failed: (sessionKey: string, cause: unknown, runId?: string) => void | Promise<void>
  stop: (sessionKey: string) => void | Promise<void>
}
export class PiSessionPool implements PiRuntime {
  private edits = new Map<string, 'stopping' | 'sending'>()
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
  runningSessionKeys() {
    const keys = new Set<string>()
    for (const record of this.sessions.values()) {
      const queue = record.queue?.event
      const pending =
        queue?.type === 'queue_update'
          ? queue.steering.length + queue.followUp.length
          : record.state.pendingMessageCount
      if (
        record.running ||
        record.pendingPrompt ||
        record.state.isCompacting ||
        record.state.retry ||
        record.tools.size ||
        [...record.extensions.keys()].some((key) => key.startsWith('dialog:')) ||
        (!record.state.stopped && !record.state.queuePaused && pending)
      )
        keys.add(record.key)
    }
    return keys
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
  private readonly titles = new SessionTitleRequests()
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
              await this.captureSnapshot(record)
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
          await this.stopRuntime(record)
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
  private stopRuntime(record: RuntimeSession) {
    const pending = record.session.stopAndWait()
    record.workerStopping = pending
    this.retired.add(pending)
    void pending.then(
      () => {
        this.retired.delete(pending)
        if (record.workerStopping === pending) record.workerStopping = undefined
      },
      () => {
        this.retired.delete(pending)
        // 未确认退出时保留失败状态，dormant 写入不得接管旧 Worker 的 JSONL。
      },
    )
    return pending
  }
  private stopRecord(record: RuntimeSession) {
    this.stopRuntime(record)
    const interval = record.state.runIntervals?.at(-1)
    if (interval && interval.endedAt === undefined)
      record.state = {
        ...record.state,
        runIntervals: record.state.runIntervals?.map((value) =>
          value === interval ? { ...value, endedAt: Date.now() } : value,
        ),
      }
  }
  async stopAndWait() {
    this.changing = true
    this.clearWarmup()
    this.titles.cancel()
    await Promise.allSettled(this.titles.writes.values())
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
    const saved = record.restored || record.messages.length > 0 || (record.totalMessages ?? 0) > 0
    return saved ? (record.session.getActiveSession().sessionFile ?? record.sessionFile ?? record.key) : record.key
  }
  retainSession(sessionKey: string) {
    const record = this.sessions.get(sessionKey)
    if (!record) throw new Error('目标会话不存在')
    record.retained = true
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
  private sessionForPath(sessionPath: string) {
    return (
      this.sessions.get(sessionPath) ??
      [...this.sessions.values()].find(
        (item) => item.sessionFile === sessionPath || this.recordPath(item) === sessionPath,
      )
    )
  }

  private automaticSessionTitle(record: RuntimeSession, message: Extract<PiMessage, { role: 'user' }>) {
    if (!record.awaitingTitleInput) return
    const text = titleUserText(message)
    if (!text) return
    record.awaitingTitleInput = false
    if (explicitSessionName(record.name, text)) return
    const key = record.sessionFile ?? record.key
    void this.titles.run(key, 'automatic', async (signal) => {
      const { model, name } = await record.session.getSessionTitleContext()
      if (!model || explicitSessionName(name, text)) return null
      const title = await generateSessionTitle(
        this.runtimePaths.agentDir,
        this.credentialStorage,
        model,
        sessionTitlePrompt(text),
        signal,
      )
      if (title && !signal.aborted && this.sessions.get(record.key) === record) {
        await this.writeSessionName(record.key, title, { signal, preview: text })
      }
      return title
    })
  }

  suggestSessionName(sessionPath: string) {
    const record = this.sessionForPath(sessionPath)
    if (record?.temporary) return Promise.resolve(null)
    const key = record?.sessionFile ?? sessionPath
    return this.titles.run(key, 'suggestion', async (signal) => {
      if (key.startsWith('runtime:')) return null
      const [history, live] = await Promise.all([
        readSessionHistory(key),
        record && !record.dormant && record.session.connection().status === 'ready'
          ? record.session.getSessionTitleContext()
          : undefined,
      ])
      const prompt = suggestedTitlePrompt(history.messages)
      if (!prompt) return null
      let model = live?.model ?? record?.state.model ?? history.model
      if (!model) {
        const [models, preferences] = await Promise.all([
          readLocalModels(this.runtimePaths.agentDir, this.credentialStorage),
          readLocalPreferences(history.cwd, this.runtimePaths.agentDir),
        ])
        model = defaultModelConfiguration(models, preferences)?.model
      }
      return model
        ? generateSessionTitle(this.runtimePaths.agentDir, this.credentialStorage, model, prompt, signal)
        : null
    })
  }

  renameSession(sessionPath: string, name: string) {
    const record = this.sessionForPath(sessionPath)
    if (record) record.awaitingTitleInput = false
    this.titles.cancel(record?.sessionFile ?? sessionPath)
    return this.writeSessionName(sessionPath, name)
  }

  private writeSessionName(sessionPath: string, name: string, automatic?: { signal: AbortSignal; preview: string }) {
    const origin = this.sessionForPath(sessionPath)
    const key = origin?.sessionFile ?? sessionPath
    return this.titles.write(key, async () => {
      const targetPath = origin ? this.recordPath(origin) : sessionPath
      const file = targetPath.startsWith('runtime:') || origin?.temporary ? undefined : targetPath
      if (file) {
        const [root, target] = await Promise.all([realpath(this.runtimePaths.sessionsDirectory), realpath(file)])
        if (!pathWithin(root, target)) throw new Error('Desktop 只能修改应用内保存的会话')
      }
      const sdk = file ? await loadPiSdk() : undefined
      const cwd = origin?.cwd ?? (file && (await readSessionHistory(file)).cwd)
      const record = origin ?? this.sessionForPath(sessionPath)
      await record?.starting
      await record?.workerStopping
      automatic?.signal.throwIfAborted()
      this.assertPathAvailable(sessionPath)
      if (file) this.assertPathAvailable(file)
      if (record) {
        if (this.sessions.get(record.key) !== record) throw new Error('目标会话已关闭')
        this.checkoutGate?.(record.cwd)
        this.assertWorkspaceAvailable(record.cwd)
        this.assertPathAvailable(record.key)
        if (record.stopping || record.accessChanging) throw new Error('目标会话正在停止或修改权限，请稍后重命名')
        if (automatic && explicitSessionName(record.name, automatic.preview)) return
      }
      if (record && !record.dormant) {
        name = await record.session.setSessionName(name, automatic?.preview)
      } else if (file && cwd && sdk) {
        const manager = sdk.SessionManager.open(file, this.runtimePaths.sessionDirectory(cwd), cwd)
        const saved = manager.getSessionName()
        if (automatic && explicitSessionName(saved, automatic.preview)) return
        if (saved !== name) manager.appendSessionInfo(name)
      } else if (!record) throw new Error('目标会话不存在')
      if (record && record.name !== name) {
        this.handleEvent(record, {
          generation: record.executionGeneration,
          event: { type: 'session_info_changed', name },
        })
      }
      if (file) invalidateSessionHistory([file])
      this.notify.sessionsChanged({ paths: [file ?? sessionPath], kind: 'append' })
    })
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
      const titleKeys = new Set([...paths, ...records.map((record) => record.sessionFile ?? record.key)])
      for (const key of titleKeys) this.titles.cancel(key)
      await Promise.allSettled([...titleKeys].map((key) => this.titles.writes.get(key)))
      await Promise.all(
        records.map(async (record) => {
          record.cancelledPrompt = true
          await this.aborts.get(record.key)
          await this.collaboration?.stop(record.key)
          await record.session.stopAndWait()
          this.setExecutionPhase(record, 'idle')
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
      const removed = records.filter(
        (record) => deleted.has(this.recordPath(record)) || deleted.has(record.key) || (cwd && !result.errors.length),
      )
      const deletedKeys = removed.map((record) => record.key)
      const activeRemoved = removed.includes(this.active)
      const previous = this.active
      for (const record of removed) this.sessions.delete(record.key)
      invalidateSessionHistory(result.deletedPaths)
      await removeHistoryIndexes(result.deletedPaths)
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
      this.notify.sessionsChanged({ paths: result.deletedPaths, kind: 'rewrite' })
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
  private epoch = 0
  private commands = new Map<string, { revision?: number; value: PiSlashCommand[] }>()
  private commandReads = new Map<string, { revision: number; promise: Promise<PiSlashCommand[]> }>()
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
  private getResourceRevision?: () => number
  private getPromptTemplates?: () => Promise<PromptTemplate[]>
  configureResources(
    getResources: (cwd: string) => Promise<ResourceSnapshot>,
    getRevision?: () => number,
    getPromptTemplates?: () => Promise<PromptTemplate[]>,
  ) {
    this.getResources = getResources
    this.getResourceRevision = getRevision
    this.getPromptTemplates = getPromptTemplates
    this.commands.clear()
    this.commandReads.clear()
  }
  async refreshImportedConfiguration() {
    this.epoch++
    this.localModels = null
    this.localAvailableModels = null
    this.commands.clear()
    this.commandReads.clear()
    await this.retireSessions(() => true)
  }
  configureResourceDiscovery(enabled: boolean) {
    this.resourceDiscovery = enabled
    this.commands.clear()
    this.commandReads.clear()
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
  validateDefaultAccessMode(mode: AgentAccessMode) {
    if (!isAgentAccessMode(mode)) throw new Error('Agent 访问权限无效')
    if (this.restrictedAccess && mode !== this.defaultMode) this.assertExecutionAccess(mode, 'default')
  }
  async configureDefaultAccessMode(mode: AgentAccessMode) {
    if (!isAgentAccessMode(mode)) throw new Error('Agent 访问权限无效')
    // 启动恢复及已保存设置的提交不重新探测，避免失败回滚时被环境变化阻断。
    this.defaultMode = mode
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
  private assertExecutionAccess(access: AgentAccessMode, mode: TaskMode) {
    if (effectiveAgentAccess(access, mode) !== 'full-access' && !this.restrictedAccess?.supported)
      throw new Error(this.restrictedAccess?.reason ?? '受限权限沙箱不可用')
  }
  private configureSession(record: RuntimeSession, mode = record.state.mode) {
    this.assertExecutionAccess(record.accessMode, mode)
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
      sessionsChanged: (change?: { paths: string[]; kind: 'append' | 'rewrite' }) => void
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
      accessRevision: this.active ? (this.active.modeRevision ?? 0) : undefined,
      editPhase: this.edits.get(this.active?.key),
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
    record.accessReady = record.accessReady.then(async () => {
      if (!this.sessions.has(record.key)) return
      this.configureSession(record)
      await record.session.setSessionMode(record.state.mode)
      record.session.start(cwd, sessionFile)
    })
    void record.accessReady.catch(() => {})
  }
  createTemporarySession(
    cwd: string,
    options?: {
      temporaryRoot?: string
      accessMode?: AgentAccessMode
      model?: PiModel
      thinkingLevel?: SessionThinkingLevel
    },
  ): RuntimeSession {
    const record = this.create(cwd, undefined, undefined, options?.accessMode, true, {
      temporary: true,
      temporaryRoot: options?.temporaryRoot,
      model: options?.model,
      thinkingLevel: options?.thinkingLevel,
      setActive: false,
    })
    void this.warmMetadata(record)
    return record
  }
  async closeTemporarySession(sessionKey: string): Promise<void> {
    const record = this.sessions.get(sessionKey)
    if (!record || !record.temporary) return
    record.stopping = true
    try {
      await record.session.abort()
    } catch {
      /* ignore */
    }
    const pending = record.session.stopAndWait()
    this.retired.add(pending)
    try {
      await pending
      this.sessions.delete(sessionKey)
    } finally {
      this.retired.delete(pending)
    }
  }
  private create(
    cwd: string,
    sessionFile?: string,
    history?: SessionHistoryData,
    inheritedMode?: AgentAccessMode,
    preservePrevious = false,
    options?: {
      key?: string
      temporary?: boolean
      temporaryRoot?: string
      model?: PiModel
      thinkingLevel?: SessionThinkingLevel
      setActive?: boolean
    },
  ) {
    this.assertWorkspaceAvailable(cwd)
    if (!preservePrevious) this.discardEmpty()
    const key = options?.key ?? `runtime:${randomUUID()}`
    const record: RuntimeSession = {
      key,
      temporary: options?.temporary,
      temporaryRoot: options?.temporaryRoot,
      accessMode: inheritedMode ?? this.defaultMode,
      accessReady: Promise.resolve(),
      accessChanging: false,
      stopping: false,
      cwd,
      session: null!,
      sessionFile,
      restored: Boolean(sessionFile),
      awaitingTitleInput: !sessionFile && !options?.temporary,
      dormant: true,
      cancelledPrompt: false,
      state: {
        mode: 'default',
        model: options?.model ?? history?.model,
        thinkingLevel: options?.thinkingLevel ?? history?.thinkingLevel,
        modelServiceTiers: history?.modelServiceTiers,
        sessionName: history?.sessionName,
        skillUsages: history?.skillUsages,
        recovery: history?.recovery,
        isStreaming: false,
        isCompacting: false,
        steeringMode: this.defaults?.steeringMode ?? 'one-at-a-time',
        followUpMode: this.defaults?.followUpMode ?? 'all',
        pendingMessageCount: 0,
      },
      phase: 'idle',
      phaseRevision: 0,
      get running() {
        return this.phase !== 'idle'
      },
      get pendingPrompt() {
        return this.phase === 'submitting'
      },
      snapshotRequest: 0,
      acceptedSnapshot: 0,
      run: 0,
      touched: Date.now(),
      created: history?.created ?? new Date().toISOString(),
      completedAt: sessionFile ? undefined : null,
      name: history?.sessionName,
      messages: history?.messagePage ? [] : (history?.messages.slice() ?? []),
      totalMessages: history?.totalMessages,
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
    if (history) this.restoreTaskControl(record, history)
    const effectivePaths = options?.temporaryRoot
      ? createTemporaryRuntimePaths(this.runtimePaths, options.temporaryRoot)
      : this.runtimePaths
    record.session = this.sessionFactory(
      cwd,
      {
        connection: (connection) => {
          if (this.sessions.get(key) !== record || connection.generation < record.executionGeneration) return
          record.executionGeneration = connection.generation
          if (connection.status === 'disconnected') {
            const running = record.running || record.pendingPrompt
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
          }
          this.notify.connection(this.withSession(record.key, () => this.connection()))
          this.notify.sessionsChanged()
          if (record.session.connection().status === 'ready') this.prune()
          this.signalSettled()
        },
        event: (value) => {
          const generation = value.executionGeneration ?? value.generation
          if (
            this.sessions.get(key) !== record ||
            generation !== record.session.connection().generation ||
            generation < record.executionGeneration
          )
            return
          record.executionGeneration = generation
          this.handleEvent(record, value)
        },
        error: (value) => {
          if (this.sessions.get(key) !== record || value.generation !== record.session.connection().generation) return
          const error = { ...value, generation: this.generation, sessionKey: key }
          if (value.extension) record.extensionError = error
          this.notify.error(error)
          this.notify.sessionsChanged()
        },
        title: (value) => {
          if (record === this.active) this.notify.title?.(value)
        },
      },
      effectivePaths,
      this.credentialStorage,
      this.mcpExtensionFactory,
      key,
    )
    if (sessionFile && !inheritedMode && !record.temporary) {
      record.accessReady = this.accessStore.get(sessionFile).then((mode) => {
        record.accessMode = mode
      })
      void record.accessReady.catch(() => {})
    }
    this.sessions.set(key, record)
    if (options?.setActive !== false) {
      this.active = record
      this.generation += 1
      this.notify.connection(this.connection())
      this.prune()
      this.notify.sessionsChanged()
    }
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
    if (record && (event.executionGeneration === undefined || event.executionGeneration >= record.executionGeneration))
      this.handleEvent(record, {
        ...event,
        executionGeneration: event.executionGeneration ?? record.executionGeneration,
      })
  }
  private runtimeState(record: RuntimeSession): PiState {
    return { ...record.state, executionPhase: record.phase, isStreaming: record.running }
  }
  private setExecutionPhase(record: RuntimeSession, phase: SessionExecutionPhase) {
    if (record.phase === phase) return
    record.phase = phase
    record.phaseRevision++
    this.handleEvent(record, {
      generation: record.executionGeneration,
      event: { type: 'execution_phase', phase },
    })
    this.notify.sessionsChanged()
  }
  private handleEvent(record: RuntimeSession, value: DesktopEvent, completedTurn = true) {
    if (this.sessions.get(record.key) !== record) return
    const event = value.event
    if ('hostSubmission' in event && event.hostSubmission !== undefined && event.hostSubmission !== record.run) return
    if (event.type === 'service_tier_update')
      record.state = { ...record.state, modelServiceTiers: event.modelServiceTiers }
    if (event.type === 'session_saved') {
      if (!record.temporary && record.sessionFile !== event.sessionFile) {
        void this.accessStore.set(event.sessionFile, record.accessMode).catch((cause: unknown) =>
          this.notify.error({
            generation: this.generation,
            sessionKey: record.key,
            message: `无法保存会话权限：${String(cause)}`,
          }),
        )
      }
      record.sessionFile = event.sessionFile
      markHistoryAppend(event.sessionFile)
      if (!record.temporary) this.notify.sessionsChanged({ paths: [event.sessionFile], kind: 'append' })
      return
    }
    if (event.type === 'agent_settled') {
      if (!record.running) return
      if (completedTurn) record.completedAt = new Date().toISOString()
      this.setExecutionPhase(record, 'idle')
    } else if (
      event.type === 'agent_start' ||
      event.type === 'compaction_start' ||
      event.type === 'auto_retry_start' ||
      event.type === 'summarization_retry_scheduled'
    ) {
      this.setExecutionPhase(record, 'running')
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
    if (
      (event.type === 'agent_start' || event.type === 'agent_settled' || event.type === 'message_end') &&
      event.runIntervals
    )
      record.state = { ...record.state, runIntervals: event.runIntervals }
    if (event.type === 'agent_settled') {
      record.state = { ...record.state, isStreaming: false, isCompacting: false, activeMode: undefined }
      void this.collaboration?.settled(record.key, { ...event, runId: recordEvent.runId })
      record.liveEvents = []
      record.tools.clear()
    }
    this.rememberRecoveryEvent(record, event)
    if (event.type === 'message_start' && event.message.role === 'assistant') record.liveEvents = [recordEvent]
    if (event.type === 'message_update') record.liveEvents.push(recordEvent)
    if (event.type === 'session_info_changed') {
      record.name = event.name
      record.state = { ...record.state, sessionName: event.name }
      const key = record.sessionFile ?? record.key
      if (!this.titles.writes.has(key)) this.titles.cancel(key)
    }
    if (event.type === 'message_end') {
      this.rememberMessage(record, event.message)
      if (event.message.role === 'user') this.automaticSessionTitle(record, event.message)
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
    if (event.type === 'stop_update') record.state = { ...record.state, stopped: event.stopped }
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
      event.type === 'session_info_changed' ||
      event.type === 'message_end' ||
      event.type === 'pause_update' ||
      event.type === 'extension_ui_request' ||
      event.type === 'extension_ui_closed' ||
      event.type === 'extension_ui_timeout'
    ) {
      this.notify.sessionsChanged(
        event.type === 'agent_settled' && record.sessionFile && !record.temporary
          ? { paths: [record.sessionFile], kind: 'rewrite' }
          : undefined,
      )
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
      if (record.sessionFile) {
        invalidateSessionHistory([record.sessionFile])
        if (!record.temporary) this.notify.sessionsChanged({ paths: [record.sessionFile], kind: 'rewrite' })
      }
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
    if (record.sessionFile) markHistoryAppend(record.sessionFile)
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
      record.retained ||
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
          !record.temporary &&
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
    this.titles.cancel()
    this.clearWarmup()
    this.epoch += 1
    this.selection += 1
    for (const record of this.sessions.values()) this.stopRecord(record)
    this.sessions.clear()
  }
  private async selectionResult(selection: number, window?: SessionWindow): Promise<SessionSelectionResult> {
    if (selection !== this.selection) return { cancelled: true }
    try {
      const snapshot = await this.snapshot(window)
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
      return result
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
  async switchSession(sessionPath: string, window?: SessionWindow): Promise<SessionSelectionResult> {
    this.assertPathAvailable(sessionPath)
    if (this.changing) throw new Error('正在修改运行时配置，请稍后切换会话')
    const selection = ++this.selection
    const existing = this.sessionForPath(sessionPath)
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
          const history = await readSessionHistory(existing.sessionFile, window)
          if (selection !== this.selection) return { cancelled: true }
          if (existing.dormant && !existing.starting && !existing.running) {
            if (!history.messagePage) existing.messages = history.messages.slice()
            existing.totalMessages = history.totalMessages
            existing.sessionEntries = history.sessionEntries
            existing.branchAttachments = history.branchAttachments?.slice()
            existing.name = history.sessionName
            existing.state = {
              ...existing.state,
              modelServiceTiers: history.modelServiceTiers,
              sessionName: history.sessionName,
              skillUsages: history.skillUsages,
              recovery: history.recovery,
            }
            this.restoreTaskControl(existing, history)
            existing.stats = history.stats
          }
        }
        this.assertPathAvailable(existing.key)
        this.assertWorkspaceAvailable(existing.cwd)
        if (this.sessions.get(existing.key) !== existing) return { cancelled: true }
        this.activate(existing)
      }
    } else {
      const sessionRoot = await realpath(this.runtimePaths.sessionsDirectory).catch(() => '')
      const sessionTarget = await realpath(sessionPath).catch(() => '')
      if (!sessionRoot || !sessionTarget || !pathWithin(sessionRoot, sessionTarget))
        throw new Error('Desktop 只能打开应用内保存的会话')
      const savedPath = path.join(this.runtimePaths.sessionsDirectory, path.relative(sessionRoot, sessionTarget))
      const history = await readSessionHistory(savedPath, window)
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
      this.assertPathAvailable(sessionTarget)
      this.assertPathAvailable(savedPath)
      this.assertWorkspaceAvailable(history.cwd)
      // Other client views can restore the same file while this view is reading its history.
      // Reuse the owner found at publication time, keeping selection and pagination per view.
      const restored = this.sessionForPath(savedPath) ?? this.sessionForPath(sessionTarget)
      if (restored) {
        this.assertPathAvailable(restored.key)
        this.activate(restored)
      } else this.create(history.cwd, savedPath, history)
    }
    return this.selectionResult(selection, window)
  }
  private restoreTaskControl(record: RuntimeSession, history: SessionHistoryData) {
    const control = history.taskControl
    const steering = control?.steering ?? []
    const followUp = control?.followUp ?? []
    record.state = {
      ...record.state,
      stopped: control?.stopped ?? false,
      queuePaused: Boolean(control?.stopped || steering.length || followUp.length),
      pendingMessageCount: steering.length + followUp.length,
    }
    record.queue =
      steering.length || followUp.length
        ? { generation: this.generation, sessionKey: record.key, event: { type: 'queue_update', steering, followUp } }
        : undefined
  }
  getActiveSession() {
    const active = this.active.session.getActiveSession()
    return { sessionFile: active.sessionFile ?? this.active.sessionFile ?? this.active.key, sessionId: this.active.key }
  }
  hasSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey)
  }
  async readHistory(sessionPath: string, window?: SessionWindow): Promise<SessionHistoryData> {
    const record = this.target(sessionPath)
    if (record.sessionFile) return readSessionHistory(record.sessionFile, window)
    return projectSessionWindow(this.getRuntimeHistory(sessionPath)!, window)
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
          modelServiceTiers: record.state.modelServiceTiers,
          temporary: record.temporary ? true : undefined,
        }
      : null
  }
  getRuntimeSessions(): PiSessionSummary[] {
    const activities = this.collaboration?.activityBySession?.()
    return [...this.sessions.values()]
      .filter((record) => this.hasContent(record))
      .map((record) => {
        const activity =
          activities?.get(record.key) ?? (record.sessionFile ? activities?.get(record.sessionFile) : undefined)
        const requests = new Set(activity?.inputRequestIds)
        for (const [key, value] of record.extensions) {
          if (key.startsWith('dialog:') && value.event.type === 'extension_ui_request')
            requests.add(JSON.stringify([record.key, value.executionGeneration ?? value.generation, value.event.id]))
        }
        return {
          id: record.key,
          path: this.recordPath(record),
          cwd: record.cwd,
          sourceProjectCwd: this.workspaceOptions?.sourceProjectCwd?.(record.cwd),
          workspaceKind: this.workspaceOptions?.kind(record.cwd) ?? 'project',
          name: record.name,
          firstMessage: record.firstMessage,
          created: record.created,
          modified: record.completedAt ?? record.created,
          completedAt: record.completedAt,
          messageCount: record.totalMessages ?? record.messages.length,
          ...projectSessionActivity(record.phase, Boolean(record.state.isPaused), Boolean(activity?.runningChild), [
            ...requests,
          ]),
          error: record.error ?? record.session.connection().error,
          temporary: record.temporary ? true : undefined,
        }
      })
  }
  async snapshot(window?: SessionWindow): Promise<Snapshot> {
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
      // 新会话启动时只有预分配路径，首条消息尚未落盘；恢复会话仍校验原生文件。
      const history =
        record.sessionFile && (!record.starting || record.restored)
          ? await readSessionHistory(record.sessionFile, window)
          : undefined
      await this.warmMetadata(record)
      const models = this.localAvailableModels ?? []
      if (record !== this.active || generation !== this.generation) throw new Error('当前查看的会话已更换')
      return projectSessionDetails(
        projectSessionWindow(
          {
            connection: this.connection(),
            extensionError: record.extensionError ? { ...record.extensionError, generation } : undefined,
            state: this.runtimeState(record),
            messages: history?.messages ?? record.messages,
            messagePage: history?.messagePage,
            historyRevision: history?.historyRevision,
            historyDetails: history?.historyDetails,
            historyAvailability: history?.historyAvailability,
            totalMessages: history?.totalMessages,
            planCheckpoints: history?.planCheckpoints,
            sessionEntries: history?.sessionEntries ?? record.sessionEntries,
            branchAttachments: history?.branchAttachments ?? record.branchAttachments,
            models,
            thinkingLevels: [...modelThinkingLevels(record.state.model)],
            stats: record.stats,
            events: [
              ...record.liveEvents,
              ...record.tools.values(),
              ...(record.queue ? [record.queue] : []),
              ...record.extensions.values(),
            ].map((event) => ({ ...event, generation })),
            eventSequence: record.sequence,
          },
          history ? undefined : window,
        ),
        window,
      )
    }
    if (record.dormant || record.starting) return projection()
    const buffer: DesktopEvent[] = []
    record.buffers.add(buffer)
    try {
      const snapshot = await this.captureSnapshot(record, window)
      if (record !== this.active || generation !== this.generation) throw new Error('当前查看的会话已更换')
      if (!snapshot || record.dormant || snapshot.connection.generation !== record.executionGeneration)
        return projection()
      return {
        ...snapshot,
        extensionError: record.extensionError ? { ...record.extensionError, generation } : undefined,
        state: this.runtimeState(record),
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
    let syncingUltraTarget: RuntimeSession | undefined
    try {
      const models =
        this.localAvailableModels ??
        (await (this.localModels ??= readLocalModels(this.runtimePaths.agentDir, this.credentialStorage)))
      if (epoch !== this.epoch) return
      this.localAvailableModels ??= models
      const target = this.sessions.has(record.key) ? record : this.active
      if (!target || !this.sessions.has(target.key)) return
      const preferences = await readLocalPreferences(target.cwd, this.runtimePaths.agentDir)
      if (epoch !== this.epoch || !this.sessions.has(target.key)) return
      const state = target.state
      const previousModel = state.model
      const previousThinking = state.thinkingLevel
      const stillCurrent = () =>
        epoch === this.epoch &&
        this.sessions.get(target.key) === target &&
        target.state === state &&
        state.model === previousModel &&
        state.thinkingLevel === previousThinking
      const requestedModel = state.modelFallback?.previous ?? previousModel
      const available = models.find(
        (entry) => entry.id === requestedModel?.id && entry.provider === requestedModel?.provider,
      )
      const fallback = available ? undefined : defaultModelConfiguration(models, preferences)
      const model = available ?? fallback?.model
      const missingModel = requestedModel && !available ? requestedModel : undefined
      let thinkingLevel = previousThinking
      if (model) {
        const preferred = preferences.modelThinkingLevels[`${model.provider}/${model.id}`] ?? preferences.thinkingLevel
        const requestedThinking =
          missingModel && previousThinking !== 'ultra' ? fallback?.thinkingLevel : previousThinking
        thinkingLevel = resolveSessionThinkingLevel(model, requestedThinking ?? preferred ?? 'medium')
        if (
          previousThinking === 'ultra' &&
          thinkingLevel === 'off' &&
          !missingModel &&
          !this.changing &&
          target.dormant &&
          target.sessionFile
        ) {
          syncingUltraTarget = target
          await target.retiring
          await target.workerStopping
          const sdk = await loadPiSdk()
          // 先落盘再发布 off；竞态跳过或保存失败时原 Ultra 选择仍可在后续读取中重试。
          if (
            !stillCurrent() ||
            !target.dormant ||
            target.pendingPrompt ||
            target.starting ||
            target.stopping ||
            target.retiring ||
            target.workerStopping ||
            !target.sessionFile
          )
            return
          this.target(target.key)
          const manager = sdk.SessionManager.open(
            target.sessionFile,
            this.runtimePaths.sessionDirectory(target.cwd),
            target.cwd,
          )
          try {
            if (
              projectSessionThinkingLevel(manager.getBranch(), manager.buildSessionProjection().thinkingLevel) ===
              'ultra'
            ) {
              if (manager.buildSessionProjection().thinkingLevel !== 'off') manager.appendThinkingLevelChange('off')
              appendSessionThinkingSelection(manager, 'off')
            }
          } finally {
            invalidateSessionHistory([target.sessionFile])
          }
          target.sessionEntries = {
            entries: projectBranchEntries(manager.getEntries(), manager.getLeafId()),
            leafId: manager.getLeafId(),
          }
        }
        if (!stillCurrent()) return
        syncingUltraTarget = undefined
        const usage = target.stats?.contextUsage
        if (usage?.estimated && target.stats) {
          const contextWindow = model.contextWindow ?? 0
          target.stats = {
            ...target.stats,
            contextUsage: {
              ...usage,
              contextWindow,
              percent: contextWindow > 0 && usage.tokens !== null ? (usage.tokens / contextWindow) * 100 : null,
            },
          }
        }
      }
      if (!stillCurrent()) return
      if (target.dormant) {
        state.steeringMode = target.queueModes?.steeringMode ?? preferences.steeringMode ?? state.steeringMode
        state.followUpMode = target.queueModes?.followUpMode ?? preferences.followUpMode ?? state.followUpMode
      }
      state.thinkingLevel = thinkingLevel
      state.model = model ?? requestedModel
      state.modelSelectionRequired = Boolean(missingModel && !model)
      state.modelFallback = missingModel
        ? {
            previous: { provider: missingModel.provider, id: missingModel.id },
            replacement: model && { provider: model.provider, id: model.id },
          }
        : undefined
    } catch (cause) {
      if (syncingUltraTarget && this.sessions.has(syncingUltraTarget.key))
        this.notify.error({
          generation: this.generation,
          sessionKey: syncingUltraTarget.key,
          message: `无法保存 Ultra 撤销，原策略仍保留。处理会话运行时或文件写入问题后重试：${String(cause)}`,
        })
      else if (record === this.active && this.sessions.has(record.key))
        this.notify.error({
          generation: this.generation,
          sessionKey: record.key,
          message: `无法读取本地模型配置：${String(cause)}`,
        })
    }
  }
  private async captureSnapshot(record: RuntimeSession, window?: SessionWindow) {
    const request = ++record.snapshotRequest
    const generation = record.executionGeneration
    const run = record.run
    const buffer: DesktopEvent[] = []
    record.buffers.add(buffer)
    try {
      const snapshot = await record.session.snapshot(window)
      if (
        this.sessions.get(record.key) !== record ||
        generation !== record.executionGeneration ||
        snapshot.connection.generation !== generation
      )
        throw new Error('会话执行代次已更换，请重新读取')
      if (request < record.acceptedSnapshot || record.run !== run || record.dormant) return undefined
      record.acceptedSnapshot = request
      const state = record.state
      this.rememberSnapshot(record, snapshot)
      for (const { event } of buffer) {
        if (event.type === 'message_end') this.rememberMessage(record, event.message)
        if (event.type === 'service_tier_update') record.state.modelServiceTiers = event.modelServiceTiers
        if (event.type === 'session_info_changed') {
          record.name = event.name
          record.state.sessionName = event.name
        }
        if (
          (event.type === 'agent_start' || event.type === 'agent_settled' || event.type === 'message_end') &&
          event.runIntervals
        )
          record.state.runIntervals = state.runIntervals
        if (event.type === 'stop_update') record.state.stopped = state.stopped
        if (event.type === 'compaction_start' || event.type === 'compaction_end' || event.type === 'agent_settled')
          record.state.isCompacting = state.isCompacting
        if (event.type === 'agent_settled') record.state.activeMode = state.activeMode
        this.rememberRecoveryEvent(record, event)
      }
      if (
        !buffer.some(({ event }) => event.type === 'execution_phase' || event.type === 'agent_settled') &&
        record.phase === 'idle' &&
        (snapshot.state.isStreaming || snapshot.state.isCompacting || snapshot.state.retry)
      )
        this.setExecutionPhase(record, 'running')
      return snapshot
    } finally {
      record.buffers.delete(buffer)
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
    if (!snapshot.messagePage) record.messages = snapshot.messages.slice()
    record.totalMessages =
      snapshot.totalMessages ?? (snapshot.messagePage ? record.totalMessages : snapshot.messages.length)
    if (snapshot.historyDetails !== 'deferred') {
      record.sessionEntries = snapshot.sessionEntries
      record.branchAttachments = snapshot.branchAttachments?.slice()
    }
    record.sessionFile = record.session.getActiveSession().sessionFile ?? record.sessionFile
    if (record !== this.active) return
    this.defaults = {
      model: snapshot.state.model,
      thinkingLevel: snapshot.state.thinkingLevel,
      steeringMode: snapshot.state.steeringMode,
      followUpMode: snapshot.state.followUpMode,
    }
    this.localAvailableModels = snapshot.models
  }
  private restoreConfiguration(record: RuntimeSession): ModelRestore {
    const saved = record.restored || record.messages.length > 0 || (record.totalMessages ?? 0) > 0
    return {
      sessionFile: record.sessionFile,
      sessionStartEvent: record.sessionStartEvent,
      // 存盘历史交给 SDK 恢复（包括扩展模型）。预览目录的替代项不能覆盖原始选择。
      model: saved ? undefined : (record.state.modelFallback?.previous ?? record.state.model),
      thinkingLevel: saved ? undefined : record.state.thinkingLevel,
      modelServiceTiers: record.state.modelServiceTiers,
    }
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
      this.configureSession(record, executionMode ?? record.state.mode)
      await record.session.setSessionMode(executionMode ?? record.state.mode)
      await record.session.reconnectModels(this.restoreConfiguration(record))
      record.sessionStartEvent = undefined
      if (record.name && !record.sessionFile) await record.session.setSessionName(record.name)
      const preferences = await readLocalPreferences(record.cwd, this.runtimePaths.agentDir)
      const steeringMode = record.queueModes?.steeringMode ?? preferences.steeringMode ?? record.state.steeringMode
      const followUpMode = record.queueModes?.followUpMode ?? preferences.followUpMode ?? record.state.followUpMode
      if (steeringMode !== preferences.steeringMode) await record.session.setSteeringMode(steeringMode)
      if (followUpMode !== preferences.followUpMode) await record.session.setFollowUpMode(followUpMode)
      await this.captureSnapshot(record)
      if (record.sessionFile && !record.temporary) await this.accessStore.set(record.sessionFile, record.accessMode)
      if (!this.sessions.has(record.key)) return
      this.commands.set(`${record.cwd}:${record.accessMode}`, { value: await record.session.getCommands() })
      this.notify.sessionsChanged(
        record.sessionFile && !record.temporary ? { paths: [record.sessionFile], kind: 'rewrite' } : undefined,
      )
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
      this.titles.writes.size > 0 ||
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
  async setAccessMode(sessionKey: string, mode: AgentAccessMode, expectedRevision?: number) {
    await this.setExecutionPolicy(sessionKey, { accessMode: mode }, expectedRevision)
  }

  private commitExecutionPolicy(record: RuntimeSession, access: AgentAccessMode, mode: TaskMode) {
    if (record.accessMode !== access || record.state.mode !== mode) {
      this.commands.delete(`${record.cwd}:${record.accessMode}`)
      this.commands.delete(`${record.cwd}:${access}`)
      record.accessMode = access
      record.state = { ...record.state, mode }
      record.modeRevision = (record.modeRevision ?? 0) + 1
    }
    return record.modeRevision ?? 0
  }

  /** 仅供 Host 恢复已保存的选择；不授予执行能力，也不创建或配置运行时。 */
  async restoreExecutionPolicy(
    sessionKey: string,
    policy: { accessMode?: AgentAccessMode; mode?: TaskMode },
    expectedRevision?: number,
  ) {
    if (policy.accessMode !== undefined && !isAgentAccessMode(policy.accessMode)) throw new Error('Agent 访问权限无效')
    if (policy.mode !== undefined && policy.mode !== 'default' && policy.mode !== 'plan')
      throw new Error('会话模式无效')
    const record = this.target(sessionKey)
    const revision = record.modeRevision ?? 0
    if (expectedRevision !== undefined && revision !== expectedRevision) return undefined
    await record.accessReady
    // A catalog snapshot may predate the permission file's last successful commit.
    const savedAccess =
      record.sessionFile && !record.temporary && policy.accessMode !== undefined
        ? await this.accessStore.savedMode(record.sessionFile)
        : undefined
    if (this.target(sessionKey) !== record || (record.modeRevision ?? 0) !== revision) {
      if (expectedRevision !== undefined) return undefined
      throw new Error('会话权限或模式已变化，请重新读取')
    }
    // 读历史可能复用界面已有的运行时；保存的旧配置不能覆盖当前选择。
    if (!record.dormant) return undefined
    this.assertNotEditing(sessionKey)
    if (!this.isSessionIdle(sessionKey, true) || record.session.connection().status !== 'disconnected')
      throw new Error('只能为未启动且空闲的会话恢复已保存的权限或模式')
    const previous = { accessMode: record.accessMode, mode: record.state.mode }
    const access = savedAccess ?? policy.accessMode ?? previous.accessMode
    const mode = policy.mode ?? previous.mode
    return { revision: this.commitExecutionPolicy(record, access, mode), previous }
  }

  async setExecutionPolicy(
    sessionKey: string,
    policy: { accessMode?: AgentAccessMode; mode?: TaskMode },
    expectedRevision?: number,
  ) {
    if (policy.accessMode !== undefined && !isAgentAccessMode(policy.accessMode)) throw new Error('Agent 访问权限无效')
    if (policy.mode !== undefined && policy.mode !== 'default' && policy.mode !== 'plan')
      throw new Error('会话模式无效')
    const record = this.target(sessionKey)
    await record.accessReady
    if (
      this.target(sessionKey) !== record ||
      (expectedRevision !== undefined && expectedRevision !== (record.modeRevision ?? 0))
    )
      throw new Error('会话权限或模式已变化，请重新读取后操作')
    const access = policy.accessMode ?? record.accessMode
    const mode = policy.mode ?? record.state.mode
    this.assertExecutionAccess(access, mode)
    if (record.accessMode === access && record.state.mode === mode) return
    if (
      !this.isSessionIdle(sessionKey, true) ||
      this.hasPendingGoalInput(sessionKey) ||
      record.session.connection().status === 'connecting'
    )
      throw new Error('主任务及子任务树结束、队列清空后可切换权限或模式')
    record.accessChanging = true
    this.notify.connection(this.withSession(record.key, () => this.connection()))
    const previousAccess = record.accessMode
    const previousMode = record.state.mode
    try {
      await this.collaboration?.beforePolicyChange?.(sessionKey, access, mode)
      const effective = effectiveAgentAccess(access, mode)
      if (effective !== 'full-access') {
        const temporary = await mkdtemp(path.join(tmpdir(), 'pi-access-preflight-'))
        try {
          const sandbox = await AccessSandbox.create({
            mode: effective,
            cwd: record.cwd,
            temporary,
            agentDir: this.runtimePaths.agentDir,
            dataRoot: this.runtimePaths.dataRoot,
          })
          await sandbox.stopAll()
        } finally {
          await rm(temporary, { recursive: true, force: true })
        }
      }
      await record.session.idle(async () => {
        if (record.session.connection().status === 'ready') await this.captureSnapshot(record)
        // 所有拒绝条件先检查，再释放旧权限下的运行时与连接。
        await record.session.stopAndWait()
        record.dormant = true
        record.extensions.clear()
        record.extensionError = undefined
        if (!this.sessions.has(record.key)) throw new Error('目标会话已关闭')
        if (access !== previousAccess && record.sessionFile && !record.temporary)
          await this.accessStore.set(record.sessionFile, access)
        try {
          if (mode !== previousMode) await this.collaboration?.modeChanged?.(sessionKey, mode)
        } catch (cause) {
          if (access !== previousAccess && record.sessionFile && !record.temporary)
            await this.accessStore.set(record.sessionFile, previousAccess)
          throw cause
        }
        const revision = this.commitExecutionPolicy(record, access, mode)
        this.handleEvent(record, {
          generation: this.generation,
          executionGeneration: record.session.connection().generation,
          event: { type: 'access_mode_changed', mode: access, revision },
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
    entryId: string,
    message: string,
    images?: PiImage[],
    skills: SkillReference[] = [],
    options?: EditMessageOptions,
  ): Promise<EditMessageResult> {
    this.assertNotEditing(sessionKey)
    const record = this.target(sessionKey)
    this.edits.set(sessionKey, 'stopping')
    this.notify.connection(this.withSession(sessionKey, () => this.connection()))
    const recoveredInputs: QueuedInput[] = []
    try {
      if (this.changing) throw new Error('会话正在切换，请稍后编辑')
      await this.ensureRuntime(record)
      await record.session.validateMessageEdit(entryId, message, options)
      await this.pause(sessionKey)
      const queued = await record.session.clearQueue()
      recoveredInputs.push(...queued.steering, ...queued.followUp)
      await this.abort(sessionKey)
      this.target(sessionKey)
      await this.collaboration?.beforeEdit?.(sessionKey)
      this.edits.set(sessionKey, 'sending')
      this.notify.connection(this.withSession(sessionKey, () => this.connection()))
      await this.prompt(sessionKey, message, images, skills, options, undefined, entryId)
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
      return { recoveredInputs }
    } catch (cause) {
      return { recoveredInputs, error: cause instanceof Error ? cause.message : String(cause) }
    } finally {
      this.edits.delete(sessionKey)
      if (this.sessions.has(sessionKey)) this.notify.connection(this.withSession(sessionKey, () => this.connection()))
    }
  }
  private assertNotEditing(sessionKey: string) {
    if (this.edits.has(sessionKey)) throw new Error('正在覆盖此会话，请等待完成后重试')
  }
  async forkReply(sessionKey: string, userTimestamp: number): Promise<SessionSelectionResult> {
    this.assertNotEditing(sessionKey)
    const source = this.target(sessionKey)
    if (source.running || source.pendingPrompt || source.stopping || this.changing)
      throw new Error('会话正在运行，请等待完成后新建会话')
    this.changing = true
    try {
      if (source.dormant) await this.ensureRuntime(source)
      const sourcePath = source.session.getActiveSession().sessionFile ?? source.sessionFile
      if (!sourcePath) throw new Error('会话尚未保存，等它完成一轮对话后再新建会话')
      const data = await source.session.getEntries()
      const path = activePath(data.entries, data.leafId)
      // 只匹配活动路径上的用户消息。调用方要传打开这轮的用户消息时间，不能传展示段起点。
      const userIndex = path.findIndex(
        (entry) => messageEntry(entry) && entry.message.role === 'user' && entry.message.timestamp === userTimestamp,
      )
      if (userIndex === -1) throw new Error('找不到这条对话，请刷新会话后重试')
      const nextUser = path.findIndex(
        (entry, index) => index > userIndex && messageEntry(entry) && entry.message.role === 'user',
      )
      const turn = path.slice(userIndex, nextUser < 0 ? undefined : nextUser)
      const reply = turn.findLastIndex(
        (entry) => messageEntry(entry) && (entry.message.role === 'assistant' || entry.message.role === 'toolResult'),
      )
      if (reply < 0) throw new Error('这段对话还没有可分叉的回复')
      // Usage and tool metadata after the reply belong to this turn. Idle configuration writes prepare the next input.
      const nextConfiguration = turn.findIndex(
        (entry, index) =>
          index > reply &&
          (entry.type === 'model_change' ||
            entry.type === 'thinking_level_change' ||
            (entry.type === 'custom' &&
              (entry.customType === serviceTierEntry || entry.customType === sessionThinkingEntry))),
      )
      const throughPoint = path.slice(0, userIndex + (nextConfiguration < 0 ? turn.length : nextConfiguration))
      const forkPoint = throughPoint.at(-1)!.id
      const pendingCalls = new Set<string>()
      for (const entry of throughPoint) {
        if (!messageEntry(entry)) continue
        if (entry.message.role === 'assistant' && Array.isArray(entry.message.content)) {
          for (const part of entry.message.content) if (part.type === 'toolCall') pendingCalls.add(part.id)
        }
        if (entry.message.role === 'toolResult') pendingCalls.delete(entry.message.toolCallId)
      }
      if (pendingCalls.size) throw new Error('这段回复的工具结果尚未保存，暂时无法新建会话')
      const agentIds = forkAgentIds(throughPoint)
      await this.collaboration?.beforeFork?.(sessionKey, agentIds)

      const result = await source.session.forkAtEntry(forkPoint)
      if (result.cancelled) return { cancelled: true }
      const forkedPath = result.sessionFile
      const history = await readSessionHistory(forkedPath)
      const selection = ++this.selection
      await this.accessStore.set(forkedPath, source.accessMode)
      const created = this.create(history.cwd, forkedPath, history, source.accessMode)
      created.sessionStartEvent = { type: 'session_start', reason: 'fork', previousSessionFile: sourcePath }
      await this.collaboration?.forked?.(sessionKey, created.key, agentIds)
      return await this.selectionResult(selection)
    } finally {
      this.changing = false
    }
  }
  private assertSubmission(record: RuntimeSession, run: number) {
    if (record.cancelledPrompt || record.run !== run || this.sessions.get(record.key) !== record)
      throw new Error('消息发送已取消')
  }
  async prompt(
    sessionKey: string,
    message: string,
    images?: PiImage[],
    skills: SkillReference[] = [],
    options?: EditMessageOptions,
    goalControl?: GoalControl,
    editEntryId?: string,
    recoveryEntryId?: string,
  ) {
    if (!editEntryId) this.assertNotEditing(sessionKey)
    const normalized = options?.plan
      ? { text: message, mode: options.mode ?? this.target(sessionKey).state.mode, commandOnly: false }
      : normalizePlanMessage(message, options?.mode ?? this.target(sessionKey).state.mode)
    if (editEntryId !== undefined && (normalized.commandOnly || builtinCommand(normalized.text)))
      throw new Error('编辑消息需要重新发送正文，不能执行内置命令')
    if (normalized.commandOnly) {
      await this.setSessionMode(sessionKey, normalized.mode)
      return
    }
    message = normalized.text
    const record = this.target(sessionKey)
    if (this.changing || record.running || record.stopping) throw new Error('当前会话正在运行或修改配置，请稍后发送')
    await record.retiring
    this.target(sessionKey)
    if (this.changing || record.running || record.stopping) throw new Error('当前会话正在运行或修改配置，请稍后发送')
    if (recoveryEntryId && (!this.isSessionIdle(sessionKey) || record.state.recovery?.entryId !== recoveryEntryId))
      throw new Error('当前失败已失效或会话正在运行，请重新读取状态')
    if (recoveryEntryId) {
      if (normalized.mode !== record.state.mode) throw new Error('恢复任务的模式与当前会话不同，请先手动切换模式再恢复')
      this.assertExecutionAccess(record.accessMode, normalized.mode)
    } else await this.setExecutionPolicy(sessionKey, { mode: normalized.mode })
    const executionRevision = record.modeRevision ?? 0
    const executionAccess = record.accessMode
    await this.collaboration?.beforeExecution?.(sessionKey, executionAccess, normalized.mode)
    this.target(sessionKey)
    if (
      normalized.mode !== record.state.mode ||
      executionAccess !== record.accessMode ||
      executionRevision !== (record.modeRevision ?? 0)
    )
      throw new Error('发送期间会话权限或模式已变化，请重新读取状态后发送')
    if (record.running || record.pendingPrompt || record.stopping)
      throw new Error('当前会话正在运行或修改配置，请稍后发送')
    const run = ++record.run
    record.cancelledPrompt = false
    record.error = undefined
    record.touched = Date.now()
    if (!goalControl && !recoveryEntryId && !record.restored && !builtinCommand(message))
      record.firstMessage ||= message
    this.setExecutionPhase(record, 'submitting')
    try {
      await this.ensureRuntime(record, normalized.mode)
      this.assertSubmission(record, run)
      await this.collaboration?.beforePrompt(sessionKey, { mode: normalized.mode, message })
      this.assertSubmission(record, run)
      record.state.activeMode = normalized.mode
      let receipt: PromptReceipt | undefined
      if (recoveryEntryId) await record.session.recover(recoveryEntryId, run)
      else if (goalControl) await record.session.continueGoalTask(message, goalControl, options, run)
      else {
        const send = () =>
          record.session.prompt(
            message,
            images,
            skills,
            { ...options, mode: normalized.mode, sourceClientId: this.viewContext.getStore()?.clientId },
            false,
            true,
            undefined,
            editEntryId,
            undefined,
            run,
          )
        const command = !options?.plan && builtinCommand(message)
        if (command && command.name === 'name' && command.args) {
          const key = record.sessionFile ?? record.key
          this.titles.cancel(key)
          await this.titles.write(key, async () => {
            await send()
          })
        } else receipt = await send()
      }
      await record.session.setSessionMode(record.state.mode)
      return receipt
    } catch (cause) {
      if (this.sessions.get(record.key) !== record || record.run !== run) throw cause
      // 失败只通知当前客户端。写进连接状态的话，之后每次刷新都会把同一条错误再显示出来。
      const message = String(cause)
      void this.collaboration?.failed(sessionKey, cause, record.executionRunId)
      this.notify.error({ generation: this.generation, sessionKey: record.key, message })
      const generation = record.executionGeneration
      const revision = record.phaseRevision
      const current = () =>
        this.sessions.get(record.key) === record &&
        run === record.run &&
        generation === record.executionGeneration &&
        revision === record.phaseRevision
      const settle = (recovery?: PiState['recovery']) =>
        this.handleEvent(record, { generation, event: { type: 'agent_settled', recovery } }, false)
      if (record.running && record.session.connection().status === 'ready') {
        try {
          await this.captureSnapshot(record)
          if (current()) {
            if (record.state.isStreaming || record.state.isCompacting) this.setExecutionPhase(record, 'running')
            else settle(record.state.recovery)
          }
        } catch {
          if (current()) settle()
        }
      } else if (record.running) settle()
      throw cause
    } finally {
      this.signalSettled()
    }
  }
  async recover(sessionKey: string, failureEntryId: string) {
    const record = this.target(sessionKey)
    const recovery = record.state.recovery
    if (!this.isSessionIdle(sessionKey) || !recovery || recovery.entryId !== failureEntryId)
      throw new Error('当前失败已失效或会话正在运行，请重新读取状态')
    if (recovery.mode !== record.state.mode)
      throw new Error(`恢复任务需要${recovery.mode === 'plan' ? '规划' : '普通'}模式，请先手动切换模式再恢复`)
    await this.prompt(
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
  async continueGoalTask(key: string, message: string, control: GoalControl, configuration?: MessageConfiguration) {
    await this.prompt(key, message, undefined, [], { mode: 'default', ...configuration }, control)
  }
  async steer(
    sessionKey: string,
    message: string,
    images?: PiImage[],
    skills?: SkillReference[],
    options?: MessageOptions,
  ) {
    this.assertNotEditing(sessionKey)
    const record = this.target(sessionKey)
    if (!this.isSessionIdle(sessionKey) && record.session.connection().status !== 'ready')
      await this.ensureRuntime(record, options?.mode)
    if (this.isSessionIdle(sessionKey)) {
      await this.prompt(sessionKey, message, images, skills, options)
      return
    }
    return record.session.steer(message, images, skills, {
      ...options,
      sourceClientId: this.viewContext.getStore()?.clientId,
    })
  }
  async followUp(
    sessionKey: string,
    message: string,
    images?: PiImage[],
    skills?: SkillReference[],
    options?: MessageOptions,
  ) {
    this.assertNotEditing(sessionKey)
    const record = this.target(sessionKey)
    if (!this.isSessionIdle(sessionKey) && record.session.connection().status !== 'ready')
      await this.ensureRuntime(record, options?.mode)
    if (this.isSessionIdle(sessionKey)) {
      await this.prompt(sessionKey, message, images, skills, options)
      return
    }
    return record.session.followUp(message, images, skills, {
      ...options,
      sourceClientId: this.viewContext.getStore()?.clientId,
    })
  }
  peekModels(): PiModel[] {
    return structuredClone(this.localAvailableModels ?? [])
  }
  peekDefaults() {
    return structuredClone(this.defaults ?? null)
  }
  /** Read an existing record without activating it, warming metadata or contacting its Worker. */
  peekSnapshot(sessionKey: string): Snapshot | undefined {
    const record = this.sessions.get(sessionKey)
    if (!record) return undefined
    return structuredClone({
      connection: {
        generation: this.generation,
        sessionKey: record.key,
        sessionFile: record.sessionFile,
        cwd: record.cwd,
        status: record.dormant ? 'idle' : record.session.connection().status,
        accessMode: record.accessMode,
        accessRevision: record.modeRevision ?? 0,
      },
      state: this.runtimeState(record),
      messages: record.messages,
      models: [],
      stats: record.stats,
      sessionEntries: record.sessionEntries,
      branchAttachments: record.branchAttachments,
      events: [
        ...record.liveEvents,
        ...record.tools.values(),
        ...(record.queue ? [record.queue] : []),
        ...record.extensions.values(),
      ],
      eventSequence: record.sequence,
    })
  }
  getRuntimeSession(sessionKey: string) {
    return this.target(sessionKey).session
  }
  getSessionContext(sessionKey: string) {
    const record = this.target(sessionKey)
    return {
      sessionKey,
      cwd: record.cwd,
      state: this.runtimeState(record),
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
      state: this.runtimeState(record),
      accessMode: record.accessMode,
      sessionFile: record.sessionFile,
      sessionId: record.session.getActiveSession().sessionId ?? record.stats?.sessionId,
      session: record.session,
      // 预分配路径不等于有已保存历史；恢复过的文件丢失仍须报错。
      historySaved: record.restored || record.messages.length > 0 || (record.totalMessages ?? 0) > 0,
      modeRevision: record.modeRevision ?? 0,
      temporary: record.temporary ? true : undefined,
    }
  }
  restoreSessionMode(sessionKey: string, mode: TaskMode, expected: { mode: TaskMode; revision: number }) {
    const record = this.sessions.get(sessionKey)
    if (!record) throw new Error('目标会话已关闭，请重新打开后发送')
    if (record.state.mode === expected.mode && (record.modeRevision ?? 0) === expected.revision)
      this.commitExecutionPolicy(record, record.accessMode, mode)
    return record.state.mode
  }
  async setSessionMode(sessionKey: string, mode: TaskMode) {
    await this.setExecutionPolicy(sessionKey, { mode })
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
    if (record.pendingPrompt) record.cancelledPrompt = true
    record.stopping = true
    this.notify.connection(this.withSession(record.key, () => this.connection()))
    try {
      await this.collaboration?.stop(sessionKey)
      if (record.pendingPrompt && record.starting) {
        await record.starting.catch(() => {})
        return
      }
      await record.session.abort()
      if (record.running && this.sessions.has(record.key))
        this.handleEvent(record, {
          generation: this.generation,
          executionGeneration: record.session.connection().generation,
          event: { type: 'agent_settled', aborted: true },
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
  async stopTask(sessionKey: string) {
    const record = this.target(sessionKey)
    if (record.pendingPrompt) record.cancelledPrompt = true
    record.stopping = true
    this.notify.connection(this.withSession(record.key, () => this.connection()))
    try {
      await record.session.stopTask()
      await this.collaboration?.stop(sessionKey)
    } finally {
      record.stopping = false
      this.signalSettled()
      this.notify.connection(this.withSession(record.key, () => this.connection()))
    }
  }
  async continueStopped(sessionKey: string, configuration?: import('@pi-meme/contracts/plan').MessageConfiguration) {
    this.assertNotEditing(sessionKey)
    const record = this.target(sessionKey)
    if (record.running || record.pendingPrompt || record.stopping) throw new Error('当前会话正在执行，请稍后重试')
    const run = ++record.run
    record.cancelledPrompt = false
    this.setExecutionPhase(record, 'submitting')
    try {
      await this.ensureRuntime(record, record.state.mode)
      this.assertSubmission(record, run)
      await record.session.continueStopped(configuration, run)
    } catch (cause) {
      if (record.run === run) this.setExecutionPhase(record, 'idle')
      throw cause
    } finally {
      this.notify.sessionsChanged()
      this.signalSettled()
    }
  }
  async resume(sessionKey: string) {
    this.assertNotEditing(sessionKey)
    const record = this.target(sessionKey)
    if (record.dormant) await this.ensureRuntime(record, record.state.mode)
    return this.collaboration?.resume ? this.collaboration.resume(sessionKey) : record.session.resume()
  }
  async steerQueueInput(sessionKey: string, id: string) {
    this.assertNotEditing(sessionKey)
    const record = this.target(sessionKey)
    await record.session.steerQueueInput(id)
    if (record.state.isPaused || record.state.queuePaused) await this.resume(sessionKey)
  }
  deleteQueueInput(sessionKey: string, id: string) {
    this.assertNotEditing(sessionKey)
    return this.target(sessionKey).session.deleteQueueInput(id)
  }
  private queueOwner() {
    const clientId = this.viewContext.getStore()?.clientId
    if (!clientId) throw new Error('排队编辑缺少客户端身份')
    return clientId
  }
  beginQueueEdit(sessionKey: string, id: string) {
    this.assertNotEditing(sessionKey)
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
    this.assertNotEditing(sessionKey)
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
    this.assertNotEditing(sessionKey)
    return this.target(sessionKey).session.clearQueue()
  }
  async setSteeringMode(sessionKey: string, mode: 'all' | 'one-at-a-time') {
    const record = this.target(sessionKey)
    record.state = record.dormant ? { ...record.state, steeringMode: mode } : await record.session.setSteeringMode(mode)
    record.queueModes = { ...record.queueModes, steeringMode: mode }
    return record.state
  }
  async setFollowUpMode(sessionKey: string, mode: 'all' | 'one-at-a-time') {
    const record = this.target(sessionKey)
    record.state = record.dormant ? { ...record.state, followUpMode: mode } : await record.session.setFollowUpMode(mode)
    record.queueModes = { ...record.queueModes, followUpMode: mode }
    return record.state
  }
  async getCommands() {
    const record = this.active
    const key = `${record.cwd}:${record.accessMode}`
    if (record.dormant || record.starting) {
      const revision = this.getResourceRevision?.()
      const cached = this.commands.get(key)
      if (revision !== undefined && cached?.revision === revision) return [...builtinCommands, ...cached.value]
      const existing = this.commandReads.get(key)
      if (revision !== undefined && existing?.revision === revision)
        return [...builtinCommands, ...(await existing.promise)]
      const read = {
        revision: revision ?? -1,
        promise: (async () => {
          const [snapshot, templates] = await Promise.all([
            this.resourceDiscovery ? this.getResources?.(record.cwd) : undefined,
            this.getPromptTemplates?.(),
          ])
          const prompts = (templates ?? []).map(({ name, description, sourceInfo }): PiSlashCommand => ({
            name,
            description,
            source: 'prompt',
            sourceInfo,
          }))
          return [...(snapshot ? readLocalSkills(snapshot) : []), ...prompts]
        })(),
      }
      this.commandReads.set(key, read)
      try {
        const value = await read.promise
        if (this.commandReads.get(key) === read && revision === this.getResourceRevision?.())
          this.commands.set(key, { revision, value })
        return [...builtinCommands, ...value]
      } finally {
        if (this.commandReads.get(key) === read) this.commandReads.delete(key)
      }
    }
    const commands = (await record.session.getCommands()).filter((command) => !command.name.startsWith('pi-desktop-'))
    this.commands.set(key, { value: commands })
    return [...builtinCommands, ...commands]
  }
  async setModel(sessionKey: string, model: PiModel) {
    this.assertNotEditing(sessionKey)
    const record = this.target(sessionKey)
    if (record.dormant) {
      await record.retiring
      await record.workerStopping
      const models =
        this.localAvailableModels ??
        (await (this.localModels ??= readLocalModels(this.runtimePaths.agentDir, this.credentialStorage)))
      const selected = models.find((entry) => entry.id === model.id && entry.provider === model.provider) ?? model
      const preferences = await readLocalPreferences(record.cwd, this.runtimePaths.agentDir)
      const thinkingLevel =
        record.state.thinkingLevel === 'ultra'
          ? resolveSessionThinkingLevel(selected, 'ultra')
          : resolveThinkingLevel(
              selected,
              preferences.modelThinkingLevels[`${selected.provider}/${selected.id}`] ??
                preferences.thinkingLevel ??
                resolveModelThinkingLevel(selected, record.state.thinkingLevel ?? 'medium'),
            )
      const sdk = record.sessionFile ? await loadPiSdk() : undefined
      if (this.target(sessionKey) !== record) throw new Error('会话已更换，请重新读取模型配置')
      if (record.dormant) {
        if (record.pendingPrompt || record.starting || record.stopping || record.retiring || record.workerStopping)
          throw new Error('会话正在切换，请稍后切换模型')
        if (record.sessionFile && sdk) {
          const manager = sdk.SessionManager.open(
            record.sessionFile,
            this.runtimePaths.sessionDirectory(record.cwd),
            record.cwd,
          )
          manager.appendModelChange(selected.provider, selected.id)
          const nativeLevel = resolveModelThinkingLevel(selected, thinkingLevel)
          if (nativeLevel !== manager.buildSessionProjection().thinkingLevel)
            manager.appendThinkingLevelChange(nativeLevel)
          appendSessionThinkingSelection(manager, thinkingLevel)
          record.sessionEntries = {
            entries: projectBranchEntries(manager.getEntries(), manager.getLeafId()),
            leafId: manager.getLeafId(),
          }
          invalidateSessionHistory([record.sessionFile])
        }
        record.state = {
          ...record.state,
          model: selected,
          modelSelectionRequired: false,
          modelFallback: undefined,
          thinkingLevel,
        }
        return selected
      }
    }
    const selected = await record.session.setModel(model)
    const { state } = await record.session.snapshot()
    record.state.model = selected
    record.state.thinkingLevel = state.thinkingLevel
    record.state.modelSelectionRequired = state.modelSelectionRequired
    record.state.modelFallback = state.modelFallback
    return selected
  }
  restoreDraftConfiguration(
    sessionKey: string,
    saved: Pick<ModelRestore, 'model' | 'thinkingLevel' | 'modelServiceTiers'>,
  ) {
    const record = this.target(sessionKey)
    if (record.dormant && !record.sessionFile)
      record.state = {
        ...record.state,
        model: saved.model ?? record.state.model,
        thinkingLevel: saved.thinkingLevel ?? record.state.thinkingLevel,
        modelServiceTiers: saved.modelServiceTiers,
      }
  }

  async setServiceTier(sessionKey: string, model: PiModel, tier: ServiceTier) {
    this.assertNotEditing(sessionKey)
    const record = this.target(sessionKey)
    if (record.dormant) {
      await this.warmMetadata(record)
      await record.retiring
      await record.workerStopping
    }
    const sdk = record.dormant && record.sessionFile ? await loadPiSdk() : undefined
    if (
      record !== this.target(sessionKey) ||
      record.running ||
      record.pendingPrompt ||
      record.starting ||
      record.stopping ||
      record.retiring ||
      record.workerStopping
    )
      throw new Error('会话正在运行或切换，请为下一条消息选择速度')
    const selected = record.state.model
    if (!selected || selected.provider !== model.provider || selected.id !== model.id)
      throw new Error('当前模型已更换，请重新选择速度')
    const canonical = this.localAvailableModels?.find(
      (entry) => entry.provider === selected.provider && entry.id === selected.id,
    )
    if (record.dormant) {
      validateServiceTier(canonical, tier)
      let selections = updateModelServiceTier(selected, tier, record.state.modelServiceTiers)
      if (record.sessionFile && sdk) {
        const manager = sdk.SessionManager.open(
          record.sessionFile,
          this.runtimePaths.sessionDirectory(record.cwd),
          record.cwd,
        )
        selections = appendServiceTier(manager, selected, tier)
        record.sessionEntries = {
          entries: projectBranchEntries(manager.getEntries(), manager.getLeafId()),
          leafId: manager.getLeafId(),
        }
        invalidateSessionHistory([record.sessionFile])
      }
      record.state = { ...record.state, modelServiceTiers: selections }
    } else {
      await record.session.setServiceTier(selected, tier)
      record.state.modelServiceTiers = (await record.session.snapshot()).state.modelServiceTiers
    }
    this.handleEvent(record, {
      generation: record.executionGeneration,
      event: { type: 'service_tier_update', modelServiceTiers: record.state.modelServiceTiers },
    })
  }

  async setThinkingLevel(sessionKey: string, level: SessionThinkingLevel) {
    if (!isSessionThinkingLevel(level)) throw new Error('思考强度无效')
    this.assertNotEditing(sessionKey)
    const record = this.target(sessionKey)
    if (record.dormant) {
      await this.warmMetadata(record)
      await record.retiring
      await record.workerStopping
      const sdk = record.dormant && record.sessionFile ? await loadPiSdk() : undefined
      if (this.target(sessionKey) !== record) throw new Error('会话已更换，请重新读取思考强度')
      if (record.dormant) {
        if (record.pendingPrompt || record.starting || record.stopping || record.retiring || record.workerStopping)
          throw new Error('会话正在切换，请稍后切换思考强度')
        const thinkingLevel = resolveSessionThinkingLevel(record.state.model, level)
        if (record.sessionFile && sdk) {
          const manager = sdk.SessionManager.open(
            record.sessionFile,
            this.runtimePaths.sessionDirectory(record.cwd),
            record.cwd,
          )
          const nativeLevel = resolveModelThinkingLevel(record.state.model, thinkingLevel)
          if (nativeLevel !== manager.buildSessionProjection().thinkingLevel)
            manager.appendThinkingLevelChange(nativeLevel)
          appendSessionThinkingSelection(manager, thinkingLevel)
          record.sessionEntries = {
            entries: projectBranchEntries(manager.getEntries(), manager.getLeafId()),
            leafId: manager.getLeafId(),
          }
          invalidateSessionHistory([record.sessionFile])
        }
        record.state = { ...record.state, thinkingLevel }
        return
      }
    }
    await record.session.setThinkingLevel(level)
    record.state.thinkingLevel = (await record.session.snapshot()).state.thinkingLevel
  }
  async getAvailableThinkingLevels() {
    const record = this.active
    if (record.dormant) {
      await this.warmMetadata(record)
      if (record.dormant) return [...modelThinkingLevels(record.state.model)]
    }
    return record.session.getAvailableThinkingLevels()
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
    if (this.active.dormant) return Promise.resolve(this.restoreConfiguration(this.active))
    return this.active.session.captureRestoreState()
  }
  private async restoreRuntime(restore: ModelRestore | undefined) {
    const record = this.active
    const epoch = ++this.epoch
    const retained = [...this.sessions.values()]
    await Promise.all(
      retained.map(async (entry) => {
        if (entry.session.connection().status === 'ready') {
          await this.captureSnapshot(entry)
        }
      }),
    )
    this.localModels = null
    this.localAvailableModels = null
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
      await record.session.reconnectModels(restore ?? this.restoreConfiguration(record))
      record.sessionStartEvent = undefined
      if (epoch !== this.epoch || !this.sessions.has(record.key)) return
      if (record.session.connection().status !== 'ready') return
      await record.session.setSessionMode(record.state.mode)
      await record.session.setSteeringMode(record.state.steeringMode)
      await record.session.setFollowUpMode(record.state.followUpMode)
      await this.captureSnapshot(record)
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
    const owns = () =>
      this.sessions.get(record.key) === record &&
      record.executionGeneration === executionGeneration &&
      record.extensions.get(`dialog:${id}`) === saved
    try {
      await record.session.respondExtensionUI(id, response)
      if (!owns()) return
      this.handleEvent(record, {
        generation: this.generation,
        executionGeneration,
        event: { type: 'extension_ui_closed', id, reason: 'answered' },
      })
    } catch (cause) {
      if (owns() && (record.session.connection().status === 'disconnected' || /已取消|超时|过期/.test(String(cause))))
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
