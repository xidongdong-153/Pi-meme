import type { SubagentDefaults } from '@pi-meme/contracts/settings'
import { validateExtensionDialogResponse } from '@pi-meme/contracts/user-input'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { DesktopEvent, Snapshot } from '@pi-meme/contracts/desktop'
import {
  collaborationLimits,
  agentAvatarScenes,
  resolveAgentTarget,
  type AgentSummary,
  type AgentModelSelection,
  type AgentMailboxMessage,
  type AgentRunRef,
  type CollaborationRequest,
  type CollaborationResults,
  type PendingInteraction,
} from '@pi-meme/contracts/collaboration'
import type { PlanCheckpoint, PlanDocument, PlanState, PlanRef, SavePlanInput, TaskMode } from '@pi-meme/contracts/plan'
import { thinkingLevels, type PiState } from '@pi-meme/contracts/pi'
import type { RuntimeSdkSession } from '@pi-meme/pi-runtime/session-pool'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import { loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'
import { readSessionHistory } from '@pi-meme/pi-runtime/session-history'
import { inferAgentConversationOrigin, readAgentConversation } from '@pi-meme/pi-runtime/agent-conversation'
import { safeBranchLeaf } from '@pi-meme/pi-runtime/safe-session-fork'

import {
  loadCollaborationPartitions,
  saveCollaborationRoot,
  deleteCollaborationRoot,
  saveCollaborationPlans,
  type CollaborationRootPartition,
} from './collaboration-store'

const activeStatuses = new Set(['starting', 'running', 'waiting_children', 'waiting_input'])
type RootBinding = {
  sessionKey: string
  cwd: string
  sessionFile?: string
  sessionId?: string
  state: PiState
  accessMode: AgentAccessMode
  session: RuntimeSdkSession
  temporary?: boolean
}
type RunPolicy = Pick<AgentSummary, 'mode' | 'accessMode' | 'model' | 'thinkingLevel'>
type QueuedTask = {
  message: string
  rootTaskId: string
  epoch: number
  policy: RunPolicy
  runId: string
  delegation?: AgentRunRef[]
}
type Record = {
  summary: AgentSummary
  sourceEntryId?: string
  importedAgentId?: string
  delegation?: AgentRunRef[]
  session?: RuntimeSdkSession
  mailbox: AgentMailboxMessage[]
  consumed: string[]
  queued: QueuedTask[]
  interactions: PendingInteraction[]
  sequence: number
  events?: DesktopEvent[]
  settled?: boolean
  completion?: { report: string }
  feedbackSent?: boolean
  waitingMessages?: string[]
  delivering?: string[]
  pauseRequested?: boolean
  pauseRevision?: number
  pauseApplied?: boolean
  pendingStart?: QueuedTask
  draining?: boolean
  nextMode?: TaskMode
  replies?: Array<{ id: string; result: CollaborationResults[keyof CollaborationResults] }>
  lastAssistant?: { text: string; error?: string }
  cleaning?: boolean
}
export type HostCollaborationOptions = {
  getSubagentDefaults?: () => SubagentDefaults | undefined
  dataRoot: string
  collaborationRootsDirectory?: string
  collaborationPlansFile?: string
  plansDataDirectory?: string
  assertCheckoutAvailable?: (cwd: string) => void
  stopServicesForRun?: (run: AgentRunRef) => Promise<void>
  createSession: (
    cwd: string,
    notify: ConstructorParameters<typeof import('@pi-meme/pi-runtime/sdk/session').SdkSession>[1],
    sessionKey: string,
    parentSessionKey?: string,
  ) => RuntimeSdkSession
  emit: (event: DesktopEvent) => void
}
type Options = HostCollaborationOptions

export function createHostCollaborationBridge(options: Options) {
  return new HostCollaborationBridge(options)
}
export class HostCollaborationBridge {
  private runRef(record: Record): AgentRunRef | undefined {
    const { agentId, rootTaskId, epoch, runId } = record.summary
    return runId ? { agentId, rootTaskId, epoch, runId } : undefined
  }
  private sameRun(record: Record, ref: AgentRunRef | undefined) {
    return Boolean(
      ref &&
      record.summary.agentId === ref.agentId &&
      record.summary.rootTaskId === ref.rootTaskId &&
      record.summary.epoch === ref.epoch &&
      record.summary.runId === ref.runId,
    )
  }
  private delegationFrom(caller: Record): AgentRunRef[] {
    const owner = this.runRef(caller)
    if (!owner) throw new Error('委派方没有活动运行')
    return [owner, ...(caller.delegation ?? [])]
  }
  private busy(record: Record) {
    return (
      activeStatuses.has(record.summary.status) ||
      record.cleaning === true ||
      (record.summary.cleanup !== undefined && record.summary.cleanup.state !== 'completed')
    )
  }
  assertCheckoutIdle(matches: (cwd: string) => boolean) {
    if (
      [...this.records.values()].some(
        (record) =>
          matches(record.summary.cwd) && (this.busy(record) || record.queued.length || record.interactions.length),
      )
    )
      throw new Error('此工作目录仍有运行中的子任务或待答交互，请先结束任务')
  }
  async retireCheckout(matches: (cwd: string) => boolean) {
    for (const record of this.records.values())
      if (matches(record.summary.cwd) && record.summary.depth > 0) {
        await record.session?.stopAndWait()
        record.session = undefined
      }
  }
  private records = new Map<string, Record>()
  private callers = new WeakMap<RuntimeSdkSession, Record>()
  private roots = new Map<string, Record>()
  private temporaryRoots = new Set<string>()
  private temporarySessions = new Set<string>()
  private answers = new Set<string>()
  private plans: PlanDocument[] = []
  private planStates = new Map<string, PlanState>()
  private pendingPlans = new Map<string, PlanDocument>()
  private planSaves = new WeakMap<RuntimeSdkSession, Promise<void>>()
  private planCommits = new Map<string, { promise: Promise<void>; resolve: () => void }>()
  private listeners = new Set<() => void>()
  private userSteering = new WeakSet<Record>()
  private rootWrites = new Map<string, Promise<void>>()
  private rootBindings = new Map<string, string>()
  private planIndexWrites: Promise<void> = Promise.resolve()
  private inFlight = new Map<string, Promise<CollaborationResults[keyof CollaborationResults]>>()
  private planWrites: Promise<void> = Promise.resolve()
  private stopping = false
  private ready: Promise<void>
  constructor(private readonly options: Options) {
    this.ready = this.load()
  }
  get rootsDirectory(): string {
    return (
      this.options.collaborationRootsDirectory ?? path.join(this.options.dataRoot, 'state', 'collaboration', 'roots')
    )
  }
  get plansFile(): string {
    return (
      this.options.collaborationPlansFile ?? path.join(this.options.dataRoot, 'state', 'collaboration', 'plans.json')
    )
  }
  get plansDirectory(): string {
    return this.options.plansDataDirectory ?? path.join(this.options.dataRoot, 'data', 'plans')
  }
  private async load() {
    try {
      const { roots, plans, states } = await loadCollaborationPartitions(this.rootsDirectory, this.plansFile)
      this.plans = plans
      this.planStates = new Map(states.map((state) => [state.sessionId, state]))
      const interruptedRoots = new Set<string>()
      const interruptedRecords: Record[] = []
      const blockedCleanups: Record[] = []
      for (const partition of roots.values()) {
        for (const record of partition.records ?? []) {
          const loadedRecord: Record = {
            ...record,
            summary: { ...record.summary },
            pauseRequested: false,
            pauseRevision: 0,
            pendingStart: undefined,
            interactions: [],
            events: [],
          }
          if (activeStatuses.has(loadedRecord.summary.status)) {
            loadedRecord.summary.status = 'interrupted'
            loadedRecord.summary.error = 'Host 已重启，任务未自动恢复'
            loadedRecord.summary.report ??= loadedRecord.completion?.report
            loadedRecord.summary.runCompletedAt = new Date().toISOString()
            loadedRecord.queued = []
            interruptedRecords.push(loadedRecord)
            interruptedRoots.add(partition.rootAgentId)
          }
          if (loadedRecord.summary.cleanup?.state === 'running') {
            loadedRecord.summary.cleanup = {
              ...loadedRecord.summary.cleanup,
              state: 'blocked',
              error: 'Host 重启，清理结果无法确认',
              revision: loadedRecord.summary.cleanup.revision + 1,
            }
            interruptedRoots.add(partition.rootAgentId)
            blockedCleanups.push(loadedRecord)
          }
          loadedRecord.summary.isPaused = false
          this.records.set(loadedRecord.summary.agentId, loadedRecord)
          if (loadedRecord.summary.depth === 0) this.roots.set(loadedRecord.summary.rootSessionKey, loadedRecord)
        }
      }
      if (interruptedRoots.size > 0) {
        await this.persist([...interruptedRoots])
        for (const record of interruptedRecords) await this.publishResult(record)
        for (const record of blockedCleanups) await this.publishCleanup(record)
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }
  private recordsForRoot(rootAgentId: string): Record[] {
    return [...this.records.values()].filter((entry) => entry.summary.rootAgentId === rootAgentId)
  }
  private persist(targets: string | string[] | Record): Promise<void> {
    let rootAgentIds: string[]
    if (typeof targets === 'object' && !Array.isArray(targets)) {
      rootAgentIds = [targets.summary.rootAgentId]
    } else {
      rootAgentIds = (Array.isArray(targets) ? [...new Set(targets)] : [targets]).filter(Boolean)
    }

    if (!rootAgentIds.length) return Promise.resolve()

    const persistentRootAgentIds = rootAgentIds.filter((id) => !this.temporaryRoots.has(id))
    if (!persistentRootAgentIds.length) return Promise.resolve()

    const promises = persistentRootAgentIds.map((rootAgentId) => {
      const treeRecords = this.recordsForRoot(rootAgentId)
      if (!treeRecords.length) return Promise.resolve()

      const root = treeRecords.find((r) => r.summary.depth === 0)
      // 同步序列化冻结当前状态快照，防止后续异步执行期间内存对象被修改
      const partition: CollaborationRootPartition = {
        version: 2,
        rootAgentId,
        rootSessionKey: root?.summary.rootSessionKey ?? treeRecords[0]?.summary.rootSessionKey ?? '',
        records: treeRecords.map(
          ({
            session: _session,
            pauseRequested: _pause,
            pauseRevision: _revision,
            pauseApplied: _applied,
            pendingStart: _start,
            draining: _draining,
            waitingMessages: _waitingMessages,
            delivering: _delivering,
            cleaning: _cleaning,
            events: _events,
            ...record
          }) => structuredClone({ ...record, summary: { ...record.summary, isPaused: undefined } }),
        ),
        updatedAt: new Date().toISOString(),
      }
      const frozenPayload = `${JSON.stringify(partition, null, 2)}\n`

      const previous = this.rootWrites.get(rootAgentId) ?? Promise.resolve()
      const write = previous.then(async () => {
        await saveCollaborationRoot(this.rootsDirectory, rootAgentId, frozenPayload)
      })
      this.rootWrites.set(
        rootAgentId,
        write.catch(() => {}),
      )
      return write
    })

    return Promise.all(promises).then(() => {})
  }
  async flushAll(): Promise<void> {
    const rootAgentIds = [...new Set([...this.records.values()].map((r) => r.summary.rootAgentId))]
    if (rootAgentIds.length > 0) {
      await this.persist(rootAgentIds)
    }
  }
  private tree(record: Record) {
    return [...this.records.values()].filter((entry) => entry.summary.rootAgentId === record.summary.rootAgentId)
  }
  private emit(record: Record, event: DesktopEvent['event']) {
    const value: DesktopEvent = {
      generation: record.summary.executionGeneration,
      executionGeneration: record.summary.executionGeneration,
      sessionKey: record.summary.sessionKey,
      rootAgentId: record.summary.rootAgentId,
      agentId: record.summary.agentId,
      runId: record.summary.runId,
      sequence: record.summary.depth === 0 ? undefined : ++record.sequence,
      event,
    }
    record.events ??= []
    if (event.type === 'agent_settled' || event.type === 'agent_start') record.events = []
    if (event.type === 'tool_execution_end')
      record.events = record.events.filter(
        (saved) => !('toolCallId' in saved.event) || saved.event.toolCallId !== event.toolCallId,
      )
    if (event.type === 'queue_update')
      record.events = record.events.filter((saved) => saved.event.type !== 'queue_update')
    if (event.type === 'extension_ui_closed' || event.type === 'extension_ui_timeout')
      record.events = record.events.filter((saved) => !('id' in saved.event) || saved.event.id !== event.id)
    if (event.type === 'message_end')
      record.events = record.events.filter(
        (saved) => saved.event.type !== 'message_start' && saved.event.type !== 'message_update',
      )
    if (
      [
        'message_start',
        'message_update',
        'tool_execution_start',
        'tool_execution_update',
        'queue_update',
        'extension_ui_request',
      ].includes(event.type)
    )
      record.events.push(value)
    this.options.emit(value)
  }
  private changed(record: Record) {
    record.summary.updatedAt = new Date().toISOString()
    this.emit(record, { type: 'agents_update', agents: this.tree(record).map((entry) => ({ ...entry.summary })) })
    for (const listener of this.listeners) listener()
  }
  async bindRoot(binding: RootBinding) {
    await this.ready
    let record = this.roots.get(binding.sessionKey)
    if (!record && binding.sessionFile)
      record = [...this.roots.values()].find((entry) => entry.summary.sessionFile === binding.sessionFile)
    if (!record) {
      const agentId = randomUUID()
      record = {
        summary: {
          agentId,
          rootAgentId: agentId,
          name: 'root',
          taskPath: '/root',
          depth: 0,
          rootSessionKey: binding.sessionKey,
          sessionKey: binding.sessionKey,
          rootTaskId: randomUUID(),
          epoch: 0,
          executionGeneration: 0,
          status: 'idle',
          cwd: binding.cwd,
          accessMode: binding.accessMode,
          mode: binding.state.mode,
          updatedAt: new Date().toISOString(),
        },
        mailbox: [],
        consumed: [],
        queued: [],
        interactions: [],
        sequence: 0,
      }
      this.records.set(agentId, record)
    }
    if (record.summary.rootSessionKey !== binding.sessionKey) {
      const previous = record.summary.rootSessionKey
      this.roots.delete(previous)
      for (const entry of this.tree(record)) {
        entry.summary.rootSessionKey = binding.sessionKey
        if (entry.summary.depth === 0) entry.summary.sessionKey = binding.sessionKey
      }
    }
    Object.assign(record.summary, {
      cwd: binding.cwd,
      executionGeneration: binding.session.connection().generation,
      sessionId: binding.sessionId ?? record.summary.sessionId,
      sessionFile: binding.sessionFile,
      accessMode: binding.accessMode,
      model: binding.state.model,
      thinkingLevel: binding.state.thinkingLevel,
    })
    record.session = binding.session
    if (
      binding.temporary ||
      (binding.session as { temporary?: boolean }).temporary === true ||
      this.temporarySessions.has(binding.sessionKey) ||
      (binding.sessionId && this.temporarySessions.has(binding.sessionId))
    ) {
      this.temporaryRoots.add(record.summary.rootAgentId)
      if (binding.sessionId) this.temporarySessions.add(binding.sessionId)
      this.temporarySessions.add(binding.sessionKey)
    }
    this.roots.set(binding.sessionKey, record)
    this.callers.set(binding.session, record)
    const signature = JSON.stringify([
      binding.sessionKey,
      binding.cwd,
      record.summary.executionGeneration,
      record.summary.sessionId,
      binding.sessionFile,
      binding.accessMode,
      binding.state.model,
      binding.state.thinkingLevel,
    ])
    if (this.rootBindings.get(record.summary.agentId) !== signature) {
      await this.persist(record)
      this.rootBindings.set(record.summary.agentId, signature)
    }
    return { ...record.summary }
  }
  private forkSelection(sessionKey: string, agentIds: readonly string[]) {
    const source = this.roots.get(sessionKey)
    if (!source || !agentIds.length) return []
    const selected = new Set<Record>()
    for (const id of agentIds) {
      const record = this.records.get(id)
      if (!record || record.summary.rootAgentId !== source.summary.rootAgentId || record.summary.depth === 0) continue
      selected.add(record)
      for (const entry of this.tree(source)) if (this.descendant(record, entry)) selected.add(entry)
    }
    return [...selected]
  }
  async prepareFork(sessionKey: string, agentIds: readonly string[]) {
    await this.ready
    if (
      this.forkSelection(sessionKey, agentIds).some(
        (entry) => activeStatuses.has(entry.summary.status) || entry.queued.length > 0,
      )
    )
      throw new Error('子代理仍在运行，结束后才能新建会话')
  }
  private async copyAgentSession(file: string, cwd: string) {
    const sdk = await loadPiSdk()
    const manager = sdk.SessionManager.forkFrom(file, cwd, path.dirname(file))
    const sessionFile = manager.getSessionFile()
    if (!sessionFile) throw new Error('子代理会话没有复制到新文件')
    return { sessionFile, sessionId: manager.getSessionId() }
  }
  async adoptFork(sourceSessionKey: string, binding: RootBinding, agentIds: readonly string[]) {
    await this.ready
    const source = this.roots.get(sourceSessionKey)
    if (!source || !binding.sessionFile) return
    if ([...this.roots.values()].some((entry) => entry.summary.sessionFile === binding.sessionFile)) return
    const selected = this.forkSelection(sourceSessionKey, agentIds)
    if (!selected.length) return
    if (selected.some((entry) => activeStatuses.has(entry.summary.status) || entry.queued.length > 0))
      throw new Error('子代理仍在运行，结束后才能新建会话')
    const copied: string[] = []
    const created: string[] = []
    const files = new Map<string, { sessionFile: string; sessionId: string }>()
    const rollback = async () => {
      for (const id of created) {
        const record = this.records.get(id)
        if (record?.session) this.callers.delete(record.session)
        this.records.delete(id)
      }
      this.roots.delete(binding.sessionKey)
      await Promise.all(copied.map((file) => rm(file, { force: true })))
    }
    try {
      for (const entry of selected) {
        if (!entry.summary.sessionFile) continue
        const copy = await this.copyAgentSession(entry.summary.sessionFile, entry.summary.cwd)
        copied.push(copy.sessionFile)
        files.set(entry.summary.agentId, copy)
      }
      const ids = new Map<string, string>([[source.summary.agentId, randomUUID()]])
      for (const entry of selected) ids.set(entry.summary.agentId, randomUUID())
      const rootId = ids.get(source.summary.agentId)!
      const root: Record = {
        summary: {
          ...structuredClone(source.summary),
          agentId: rootId,
          rootAgentId: rootId,
          parentAgentId: undefined,
          name: 'root',
          taskPath: '/root',
          depth: 0,
          rootSessionKey: binding.sessionKey,
          sessionKey: binding.sessionKey,
          rootTaskId: randomUUID(),
          executionGeneration: binding.session.connection().generation,
          status: 'idle',
          cwd: binding.cwd,
          accessMode: binding.accessMode,
          mode: binding.state.mode,
          sessionId: binding.sessionId,
          sessionFile: binding.sessionFile,
          isPaused: undefined,
          report: undefined,
          error: undefined,
          runId: undefined,
          runStartedAt: undefined,
          runCompletedAt: undefined,
          task: undefined,
          updatedAt: new Date().toISOString(),
        },
        session: binding.session,
        mailbox: [],
        consumed: [],
        queued: [],
        interactions: [],
        sequence: 0,
      }
      this.records.set(rootId, root)
      created.push(rootId)
      for (const entry of selected) {
        const agentId = ids.get(entry.summary.agentId)!
        const file = files.get(entry.summary.agentId)
        const parentAgentId = ids.get(entry.summary.parentAgentId ?? '') ?? rootId
        const summary: AgentSummary = {
          ...structuredClone(entry.summary),
          agentId,
          rootAgentId: rootId,
          parentAgentId,
          rootSessionKey: binding.sessionKey,
          sessionKey: `agent:${agentId}`,
          rootTaskId: root.summary.rootTaskId,
          executionGeneration: 0,
          isPaused: undefined,
          sessionFile: file?.sessionFile,
          sessionId: file?.sessionId,
          ...(entry.summary.conversationOrigin
            ? {
                conversationOrigin: { ...entry.summary.conversationOrigin, parentAgentId },
              }
            : {}),
          ...(entry.summary.runId ? { importedRunId: entry.summary.runId } : {}),
          updatedAt: new Date().toISOString(),
        }
        this.records.set(agentId, {
          summary,
          importedAgentId: entry.importedAgentId ?? entry.summary.agentId,
          mailbox: [],
          consumed: [],
          queued: [],
          interactions: [],
          sequence: 0,
        })
        created.push(agentId)
      }
      this.roots.set(binding.sessionKey, root)
      this.callers.set(binding.session, root)
      await this.persist(root)
      this.changed(root)
    } catch (cause) {
      await rollback()
      throw cause
    }
  }
  async setSessionMode(sessionKey: string, mode: TaskMode) {
    await this.ready
    const root = this.root(sessionKey)
    root.nextMode = mode
    await this.persist(root)
    this.changed(root)
  }
  async getSessionMode(sessionKey: string) {
    await this.ready
    const root = this.roots.get(sessionKey)
    return root?.nextMode ?? root?.summary.mode
  }
  private root(key: string) {
    const record = this.roots.get(key)
    if (!record) throw new Error('协作根会话尚未绑定')
    return record
  }
  private paused(record: Record) {
    return Boolean(this.root(record.summary.rootSessionKey).pauseRequested)
  }
  async pauseRoot(sessionKey: string) {
    await this.ready
    const root = this.root(sessionKey)
    root.pauseRequested = true
    const revision = (root.pauseRevision ?? 0) + 1
    root.pauseRevision = revision
    const tree = this.tree(root)
    const active = tree.filter((record) => record === root || activeStatuses.has(record.summary.status))
    for (const record of active) {
      record.summary.isPaused = true
      record.pauseApplied = Boolean(record.session)
    }
    this.changed(root)
    await Promise.all(active.map((record) => record.session?.setPaused(true, revision)))
  }
  async resumeRoot(sessionKey: string) {
    await this.ready
    const root = this.root(sessionKey)
    root.pauseRequested = false
    const revision = (root.pauseRevision ?? 0) + 1
    root.pauseRevision = revision
    const tree = this.tree(root)
    const gated = tree.filter((record) => record === root || record.pauseApplied)
    for (const record of tree) {
      record.summary.isPaused = false
      record.pauseApplied = false
    }
    this.changed(root)
    await Promise.all(gated.map((record) => record.session?.setPaused(false, revision)))
    if (root.pauseRequested || root.pauseRevision !== revision || this.stopping) return
    for (const record of tree) {
      const runId =
        record.pendingStart?.runId ??
        (!activeStatuses.has(record.summary.status) ? record.queued[0]?.runId : undefined) ??
        record.summary.runId
      const epoch = root.summary.epoch
      const rootTaskId = root.summary.rootTaskId
      void this.resumeRecord(record).catch((cause: unknown) => {
        if (
          this.stopping ||
          root.pauseRevision !== revision ||
          root.summary.epoch !== epoch ||
          root.summary.rootTaskId !== rootTaskId ||
          record.summary.runId !== runId ||
          ['stopped', 'interrupted'].includes(root.summary.status) ||
          ['stopped', 'interrupted'].includes(record.summary.status)
        )
          return
        record.summary.error = String(cause)
        this.changed(record)
      })
    }
  }
  private async resumeRecord(record: Record) {
    if (this.paused(record) || this.stopping || record.draining) return
    record.draining = true
    let failed = false
    try {
      const pending = record.pendingStart
      if (pending) {
        record.pendingStart = undefined
        const root = this.root(record.summary.rootSessionKey)
        if (pending.rootTaskId !== root.summary.rootTaskId || pending.epoch !== root.summary.epoch) {
          record.summary.status = 'interrupted'
          record.summary.runCompletedAt = new Date().toISOString()
          await record.session?.abort()
          await this.persist(record)
          this.changed(record)
          return
        }
        await this.start(
          record,
          pending.message,
          pending.rootTaskId,
          pending.epoch,
          pending.policy,
          pending.runId,
          pending.delegation,
        )
      } else if (!activeStatuses.has(record.summary.status)) await this.startQueued(record)
      if (this.paused(record)) return
      await this.deliver(record)
      await this.summarize(record)
    } catch (cause) {
      failed = true
      throw cause
    } finally {
      record.draining = false
      if (!failed && record.pendingStart && !this.paused(record) && !this.stopping) await this.resumeRecord(record)
    }
  }
  async beginRootRun(sessionKey: string, input: { mode: TaskMode; message: string }) {
    await this.ready
    const root = this.root(sessionKey)
    if (this.stopping) throw new Error('Host 正在停止')
    if (root.cleaning || (root.summary.cleanup && root.summary.cleanup.state !== 'completed'))
      throw new Error('子树清理尚未完成，不能开始新任务')
    this.userSteering.delete(root)
    root.waitingMessages = undefined
    root.delivering = undefined
    root.settled = false
    root.summary.epoch += 1
    root.summary.rootTaskId = randomUUID()
    for (const record of this.tree(root)) record.queued = []
    Object.assign(root.summary, {
      runId: randomUUID(),
      status: 'running',
      mode: input.mode,
      task: input.message,
      runStartedAt: new Date().toISOString(),
      runCompletedAt: undefined,
      report: undefined,
      error: undefined,
      cleanup: undefined,
    })
    await this.persist(root)
    this.changed(root)
    return { ...root.summary }
  }
  async admit(
    actualSession: RuntimeSdkSession,
    message: string,
    mode: TaskMode,
    continuation: boolean,
    signal?: AbortSignal,
  ) {
    await this.ready
    const record = this.callers.get(actualSession)
    if (!record || signal?.aborted) throw new Error('任务会话尚未绑定或准入已取消')
    if (record.summary.depth === 0 && !continuation)
      await this.beginRootRun(record.summary.sessionKey, { mode, message })
    else if (record.summary.mode !== mode || !activeStatuses.has(record.summary.status))
      throw new Error('任务轮次已结束或模式发生变化')
  }
  async admitRecovery(actualSession: RuntimeSdkSession, mode: TaskMode, signal?: AbortSignal) {
    await this.ready
    const root = this.callers.get(actualSession)
    if (!root || root.session !== actualSession || root.summary.depth !== 0 || signal?.aborted)
      throw new Error('恢复请求必须来自已绑定的根会话')
    if (this.stopping || this.paused(root)) throw new Error('当前任务已暂停或正在结束')
    if (root.cleaning || (root.summary.cleanup && root.summary.cleanup.state !== 'completed'))
      throw new Error('子树清理尚未完成，不能恢复根任务')
    const restarted = root.summary.status === 'interrupted' && root.summary.error === 'Host 已重启，任务未自动恢复'
    if (!restarted && !['idle', 'completed', 'failed', 'waiting_children', 'stopped'].includes(root.summary.status))
      throw new Error('当前任务不能恢复，请重新读取会话状态')
    root.settled = false
    Object.assign(root.summary, {
      runId: root.summary.runId ?? randomUUID(),
      runStartedAt: root.summary.runStartedAt ?? new Date().toISOString(),
      status: 'running',
      mode,
      runCompletedAt: undefined,
      error: undefined,
    })
    await this.persist(root)
    this.changed(root)
  }
  async rootFailed(sessionKey: string, cause: unknown, runId?: string) {
    const root = this.root(sessionKey)
    if ((runId && root.summary.runId !== runId) || ['stopped', 'interrupted'].includes(root.summary.status)) return
    if (root.summary.status === 'failed') return
    await this.settlePlan(root)
    root.summary.status = 'failed'
    root.summary.error = String(cause)
    root.summary.runCompletedAt = new Date().toISOString()
    root.summary.cleanup = root.summary.runId
      ? { state: 'running', causeId: `result:${root.summary.agentId}:${root.summary.runId}`, revision: 0 }
      : undefined
    await this.persist(root)
    this.changed(root)
    if (!root.summary.runId) return
    const failedRun = this.runRef(root)
    void this.cleanupFailed(root).catch((error: unknown) => {
      const cleanup = root.summary.cleanup
      if (!this.sameRun(root, failedRun) || !cleanup) return
      root.summary.cleanup = { ...cleanup, state: 'blocked', error: String(error), revision: cleanup.revision + 1 }
      this.changed(root)
      void this.persist(root)
        .then(() => this.publishCleanup(root))
        .catch(() => {})
    })
  }
  async rootSettled(sessionKey: string, event?: { aborted?: boolean; runId?: string }) {
    const root = this.root(sessionKey)
    if (event?.runId && root.summary.runId !== event.runId) return
    await this.settlePlan(root)
    if (!activeStatuses.has(root.summary.status)) return
    if (event?.aborted) {
      await this.stopRoot(sessionKey)
      return
    }
    root.settled = true
    root.summary.status =
      this.tree(root).some(
        (entry) =>
          entry !== root &&
          entry.summary.rootTaskId === root.summary.rootTaskId &&
          entry.summary.epoch === root.summary.epoch &&
          (activeStatuses.has(entry.summary.status) || entry.queued.length > 0),
      ) ||
      this.pending(root).some(
        (message) => message.rootTaskId === root.summary.rootTaskId && message.epoch === root.summary.epoch,
      )
        ? 'waiting_children'
        : 'completed'
    root.summary.runCompletedAt = root.summary.status === 'completed' ? new Date().toISOString() : undefined
    await this.persist(root)
    this.changed(root)
    await this.summarize(root)
  }
  activityCaller(session: RuntimeSdkSession) {
    const record = this.caller(session)
    if (this.stopping || this.paused(record)) throw new Error('当前任务已暂停或正在结束')
    return { ...record.summary }
  }
  goalCaller(session: RuntimeSdkSession) {
    const record = this.callers.get(session)
    if (!record || record.session !== session) throw new Error('目标请求来自无效 Worker')
    return { ...record.summary }
  }
  async goalReady(key: string, completion = false) {
    await this.ready
    const root = this.root(key)
    if (!completion && (!root.settled || root.summary.status !== 'completed')) return false
    return (
      !this.paused(root) &&
      !root.cleaning &&
      (!root.summary.cleanup || root.summary.cleanup.state === 'completed') &&
      !this.tree(root).some(
        (record) =>
          record.interactions.length ||
          record.queued.length ||
          record.pendingStart ||
          record.draining ||
          (record !== root &&
            this.busy(record) &&
            record.summary.rootTaskId === root.summary.rootTaskId &&
            record.summary.epoch === root.summary.epoch) ||
          this.pending(record).some((message) => message.kind === 'result' || message.kind === 'cleanup'),
      )
    )
  }

  private caller(session: RuntimeSdkSession) {
    const record = this.callers.get(session)
    if (!record || record.session !== session || !activeStatuses.has(record.summary.status))
      throw new Error('协作请求来自无效或已结束任务')
    return record
  }
  private target(caller: Record, target: string) {
    const identity = resolveAgentTarget(
      this.tree(caller).map((entry) => entry.summary),
      caller.summary,
      target,
    )
    const found = identity && this.records.get(identity.agentId)
    if (!found) throw new Error(`子 Agent 不存在：${target}`)
    return found
  }
  private descendant(parent: Record, child: Record) {
    return child.summary.taskPath.startsWith(`${parent.summary.taskPath}/`)
  }
  private capacity(caller: Record, reserved?: Record) {
    if (
      this.tree(caller).filter(
        (entry) => entry !== reserved && entry.summary.depth > 0 && (this.busy(entry) || entry.queued.length > 0),
      ).length >= collaborationLimits.activeChildren
    )
      throw new Error('已有 4 个活动子 Agent，请等待任务完成后再启动')
  }
  async dispatch(
    actualSession: RuntimeSdkSession,
    request: CollaborationRequest,
    signal: AbortSignal,
  ): Promise<CollaborationResults[keyof CollaborationResults]> {
    await this.ready
    const caller = this.caller(actualSession)
    if (!request.id || request.id.length > 256) throw new Error('协作请求身份无效')
    const saved = caller.replies?.find((reply) => reply.id === request.id)
    if (saved) return saved.result
    const key = `${caller.summary.agentId}:${request.id}`
    const existing = this.inFlight.get(key)
    if (existing) return existing
    const pending = this.dispatchOnce(actualSession, request, signal)
      .then(async (result) => {
        caller.replies ??= []
        caller.replies.push({ id: request.id, result })
        await this.persist(caller)
        return result
      })
      .finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, pending)
    return pending
  }
  private async dispatchOnce(
    actualSession: RuntimeSdkSession,
    request: CollaborationRequest,
    signal: AbortSignal,
  ): Promise<CollaborationResults[keyof CollaborationResults]> {
    await this.ready
    if (signal.aborted || this.stopping) throw new Error('协作请求已取消')
    const caller = this.caller(actualSession)
    const admitted = { runId: caller.summary.runId, rootTaskId: caller.summary.rootTaskId, epoch: caller.summary.epoch }
    const assertCurrent = () => {
      if (
        signal.aborted ||
        caller.summary.runId !== admitted.runId ||
        caller.summary.rootTaskId !== admitted.rootTaskId ||
        caller.summary.epoch !== admitted.epoch ||
        !activeStatuses.has(caller.summary.status)
      )
        throw new Error('协作请求所属轮次已结束或更换')
    }
    const params = request.params
    if (request.method === 'list_agent_models') {
      const snapshot = await actualSession.snapshot()
      return {
        models: snapshot.models,
        thinkingLevels: snapshot.thinkingLevels ?? [...thinkingLevels],
        current: { model: snapshot.state.model, thinkingLevel: snapshot.state.thinkingLevel },
      }
    }
    if (request.method === 'list_agents') {
      const prefix = request.params.path_prefix
      return {
        agents: this.tree(caller)
          .filter((entry) => !prefix || entry.summary.taskPath.startsWith(prefix))
          .map((entry) => ({ ...entry.summary })),
      }
    }
    if (request.method === 'wait_agent')
      return this.wait(caller, request.params.targets, request.params.timeout_ms, signal)
    if (request.method === 'finish_agent') {
      if (!caller.summary.parentAgentId) throw new Error('只有子 Agent 可以提交任务完成结果')
      if (!request.params.report.trim()) throw new Error('完成报告不能为空')
      if (
        this.tree(caller).some(
          (entry) =>
            this.descendant(caller, entry) &&
            entry.delegation?.some((ref) => this.sameRun(caller, ref)) &&
            (this.busy(entry) || entry.queued.length),
        ) ||
        this.pending(caller).length
      )
        throw new Error('请先处理未读反馈并等待下级任务完成，再提交完成结果')
      caller.completion = { report: request.params.report }
      await this.persist(caller)
      return { accepted: true }
    }
    if (request.method === 'spawn_agent') {
      this.options.assertCheckoutAvailable?.(caller.summary.cwd)
      const { task_name: name, message, avatar, fork_turns: fork = 'all' } = request.params
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || !message.trim()) throw new Error('子 Agent 名称或任务无效')
      if (avatar !== undefined && !agentAvatarScenes.includes(avatar)) throw new Error('子 Agent 头像场景无效')
      if (caller.summary.depth >= collaborationLimits.depth) throw new Error('仅主会话可以创建子代理，不支持嵌套子代理')
      const policy = await this.policy(caller, request.params)
      assertCurrent()
      const rootSession = this.root(caller.summary.rootSessionKey).session!
      const { entries, leafId } = await rootSession.getEntries()
      const byId = new Map(entries.map((entry) => [entry.id, entry]))
      let source = leafId ? byId.get(leafId) : undefined
      while (source && !(source.type === 'message' && source.message.role === 'user'))
        source = source.parentId ? byId.get(source.parentId) : undefined
      assertCurrent()
      this.capacity(caller)
      if (this.tree(caller).length - 1 >= collaborationLimits.identities) throw new Error('子 Agent 身份最多 16 个')
      const taskPath = `${caller.summary.taskPath}/${name}`
      if (this.tree(caller).some((entry) => entry.summary.taskPath === taskPath))
        throw new Error('任务名称已存在，请用 followup_task 继续已有 Agent')
      const agentId = randomUUID()
      const child: Record = {
        sourceEntryId: source?.id,
        summary: {
          ...caller.summary,
          agentId,
          parentAgentId: caller.summary.agentId,
          name,
          avatar,
          taskPath,
          depth: caller.summary.depth + 1,
          sessionKey: `agent:${agentId}`,
          executionGeneration: 0,
          conversationOrigin: {
            parentAgentId: caller.summary.agentId,
            inheritedLeafId: null,
            inheritedEntryIds: [],
          },
          sessionId: undefined,
          sessionFile: undefined,
          runId: undefined,
          status: 'starting',
          report: undefined,
          error: undefined,
          updatedAt: new Date().toISOString(),
        },
        mailbox: [],
        consumed: [],
        queued: [],
        interactions: [],
        sequence: 0,
      }
      this.records.set(agentId, child)
      try {
        if (fork === 'all') {
          const snapshot = await actualSession.getEntries()
          const leaf = safeBranchLeaf(snapshot.entries, snapshot.leafId)
          const source = actualSession.getActiveSession().sessionFile
          if (source && leaf) {
            const sdk = await loadPiSdk()
            const manager = sdk.SessionManager.open(source, path.dirname(source), caller.summary.cwd)
            child.summary.sessionFile = manager.createBranchedSession(leaf)
            child.summary.conversationOrigin = {
              parentAgentId: caller.summary.agentId,
              inheritedLeafId: manager.getLeafId(),
              inheritedEntryIds: manager.getEntries().map((entry) => entry.id),
            }
          }
        }
        assertCurrent()
        await this.start(
          child,
          message,
          admitted.rootTaskId,
          admitted.epoch,
          policy,
          undefined,
          this.delegationFrom(caller),
        )
        return { ...child.summary }
      } catch (cause) {
        this.records.delete(agentId)
        await child.session?.stopAndWait()
        await this.persist(caller)
        this.changed(caller)
        throw cause
      }
    }
    const target = this.target(caller, 'target' in params ? params.target : '')
    if (request.method === 'send_message') {
      if (caller.summary.mode === 'plan' && activeStatuses.has(target.summary.status) && target.summary.mode !== 'plan')
        throw new Error('规划模式不能向仍在执行默认模式的 Agent 派发消息，请等待结束后用 followup_task 继续')
      return this.send(caller, target, request.params.message)
    }
    if (!this.descendant(caller, target)) throw new Error('只能管理自己或祖先创建的后代任务')
    if (request.method === 'interrupt_agent') {
      const previousStatus = target.summary.status
      await this.interrupt(target)
      return { agent: { ...target.summary }, previousStatus }
    }
    if (request.method === 'followup_task') {
      if (caller.summary.depth !== 0 || target.summary.depth !== 1) throw new Error('仅主会话可以向一级子代理续派任务')
      this.options.assertCheckoutAvailable?.(caller.summary.cwd)
      if (!request.params.message.trim()) throw new Error('任务不能为空')
      const policy = await this.policy(caller, request.params)
      assertCurrent()
      if (this.busy(target)) {
        if (!activeStatuses.has(target.summary.status)) throw new Error('目标 Agent 尚未完成清理')
        target.queued.push({
          message: request.params.message,
          rootTaskId: caller.summary.rootTaskId,
          epoch: caller.summary.epoch,
          policy,
          runId: randomUUID(),
          delegation: this.delegationFrom(caller),
        })
        await this.persist([caller.summary.rootAgentId, target.summary.rootAgentId])
        return { agent: { ...target.summary }, queued: true }
      }
      this.capacity(caller)
      const previous = { ...target.summary }
      try {
        await this.start(
          target,
          request.params.message,
          caller.summary.rootTaskId,
          caller.summary.epoch,
          policy,
          undefined,
          this.delegationFrom(caller),
        )
      } catch (cause) {
        const generation = target.summary.executionGeneration
        if (activeStatuses.has(target.summary.status)) target.summary = { ...previous, executionGeneration: generation }
        await this.persist(target)
        this.changed(target)
        throw cause
      }
      return { agent: { ...target.summary }, queued: Boolean(target.pendingStart) }
    }
    throw new Error('协作工具无效')
  }
  private async policy(record: Record, selection: AgentModelSelection): Promise<RunPolicy> {
    const snapshot = await record.session!.snapshot()
    const defaults = this.options.getSubagentDefaults?.()
    const selectedModel = selection.model ?? defaults?.model
    const level = selection.thinking_level ?? defaults?.thinkingLevel ?? snapshot.state.thinkingLevel
    if (level !== undefined && !(snapshot.thinkingLevels ?? thinkingLevels).includes(level))
      throw new Error(`思考强度不可用：${level}`)
    const model = selectedModel
      ? snapshot.models.find((entry) => entry.provider === selectedModel.provider && entry.id === selectedModel.id)
      : snapshot.state.model
    if (selectedModel && !model)
      throw new Error(
        `子代理模型不可用：${selectedModel.provider}/${selectedModel.id}，请前往子代理设置重新选择或恢复继承`,
      )
    if (!model) throw new Error('主会话没有可继承的模型，请先选择模型')
    return {
      mode: record.summary.mode,
      accessMode: record.summary.accessMode,
      model,
      thinkingLevel: level,
    }
  }
  private async start(
    record: Record,
    message: string,
    rootTaskId: string,
    epoch: number,
    policy: RunPolicy,
    scheduledRunId?: string,
    delegation?: AgentRunRef[],
    allowCleaning = false,
  ) {
    if (this.stopping) throw new Error('Host 正在停止')
    if ((record.cleaning && !allowCleaning) || (record.summary.cleanup && record.summary.cleanup.state !== 'completed'))
      throw new Error('目标 Agent 尚未完成清理')
    this.options.assertCheckoutAvailable?.(record.summary.cwd)
    const replaceWorker =
      record.session && (record.summary.mode !== policy.mode || record.summary.accessMode !== policy.accessMode)
    const runId = scheduledRunId ?? randomUUID()
    const assertStarting = () => {
      if (this.stopping || record.summary.runId !== runId || !['starting', 'running'].includes(record.summary.status))
        throw new Error('子 Agent 启动已取消或轮次更换')
    }
    const task = { message, rootTaskId, epoch, policy, runId, delegation }
    this.userSteering.delete(record)
    record.completion = undefined
    record.feedbackSent = false
    record.waitingMessages = undefined
    record.delivering = undefined
    record.lastAssistant = undefined
    record.delegation = delegation
    Object.assign(record.summary, {
      rootTaskId,
      epoch,
      runId,
      status: 'starting',
      task: message,
      report: undefined,
      error: undefined,
      cleanup: undefined,
      runStartedAt: new Date().toISOString(),
      runCompletedAt: undefined,
    })
    record.summary.isPaused = this.paused(record)
    if (this.paused(record)) {
      record.pendingStart = task
      await this.persist(record)
      this.changed(record)
      return
    }
    Object.assign(record.summary, policy)
    if (replaceWorker) {
      await record.session!.stopAndWait()
      record.session = undefined
      assertStarting()
    }
    await this.persist(record)
    assertStarting()
    if (!record.summary.conversationOrigin && record.summary.parentAgentId && record.summary.sessionFile) {
      record.summary.conversationOrigin = await inferAgentConversationOrigin(
        record.summary.sessionFile,
        record.summary.parentAgentId,
      )
      assertStarting()
    }
    if (!record.session) {
      const generation = ++record.summary.executionGeneration
      await this.persist(record)
      assertStarting()
      const boundSession = this.options.createSession(
        record.summary.cwd,
        {
          connection: (connection) => {
            if (this.stopping || generation !== record.summary.executionGeneration || record.session !== boundSession)
              return
            if (connection.status === 'disconnected' && connection.error && activeStatuses.has(record.summary.status)) {
              record.summary.error = connection.error
              void this.settle(record, false).catch((cause: unknown) => {
                record.summary.error = String(cause)
                record.summary.status = 'failed'
                this.changed(record)
              })
            }
          },
          error: (error) => {
            if (this.stopping || generation !== record.summary.executionGeneration || record.session !== boundSession)
              return
            record.summary.error = error.message
            this.changed(record)
          },
          event: (event) => {
            if (this.stopping || generation !== record.summary.executionGeneration || record.session !== boundSession)
              return
            this.event(record, event)
            if (event.event.type === 'agent_settled')
              void this.settle(record, Boolean(event.event.aborted)).catch((cause: unknown) => {
                record.summary.error = String(cause)
                record.summary.status = 'failed'
                this.changed(record)
              })
          },
        },
        record.summary.sessionKey,
        this.records.get(record.summary.parentAgentId ?? '')?.summary.sessionKey ?? record.summary.rootSessionKey,
      )
      record.session = boundSession
      this.callers.set(record.session, record)
      record.session.configureAccess(record.summary.accessMode)
      const root = this.root(record.summary.rootSessionKey)
      record.pauseApplied = Boolean(root.pauseRequested)
      await boundSession.setPaused(Boolean(root.pauseRequested), root.pauseRevision ?? 0)
      assertStarting()
      await record.session.setSessionMode(record.summary.mode)
      assertStarting()
      await record.session.configureAgentTask(this.taskContext(record, message), record.summary.conversationOrigin)
      assertStarting()
      record.session.start(record.summary.cwd, record.summary.sessionFile)
      await record.session.snapshot()
      assertStarting()
      if (record.summary.model) await record.session.setModel(record.summary.model)
      if (record.summary.thinkingLevel) await record.session.setThinkingLevel(record.summary.thinkingLevel)
      record.summary.sessionId = record.session.getActiveSession().sessionId
      record.summary.sessionFile = record.session.getActiveSession().sessionFile
      await this.persist(record)
    }
    await record.session.configureAgentTask(this.taskContext(record, message), record.summary.conversationOrigin)
    if (record.summary.model) await record.session.setModel(record.summary.model)
    if (record.summary.thinkingLevel) await record.session.setThinkingLevel(record.summary.thinkingLevel)
    assertStarting()
    if (this.paused(record)) {
      record.pendingStart = task
      await this.persist(record)
      this.changed(record)
      return
    }
    record.settled = false
    record.summary.status = 'running'
    this.changed(record)
    await record.session.prompt(message, undefined, [], { mode: record.summary.mode })
    await this.deliver(record).catch((cause: unknown) => {
      record.summary.error = String(cause)
      this.changed(record)
    })
  }
  private taskContext(record: Record, message: string) {
    const parent = this.records.get(record.summary.parentAgentId ?? '')
    return `${message}\nCurrent agent: ${record.summary.taskPath}. Delegating agent: ${parent?.summary.taskPath ?? '/root'}. Root agent: /root. Address collaborators by these full paths, direct-child short names, or sibling short names.`
  }
  private acknowledge(record: Record, event: DesktopEvent['event']) {
    if (event.type !== 'message_end') return
    const message = event.message
    let ids: string[] = []
    if (message.role === 'custom' && message.customType === 'pi-meme-collaboration') {
      const id = (message.details as { messageId?: string } | undefined)?.messageId
      if (id) ids = [id]
    }
    if (message.role === 'toolResult' && message.toolName === 'wait_agent') {
      const details = message.details as { messages?: AgentMailboxMessage[] } | undefined
      ids = details?.messages?.map((entry) => entry.id) ?? []
    }
    const known = new Set(record.mailbox.map((entry) => entry.id))
    record.waitingMessages = record.waitingMessages?.filter((id) => !ids.includes(id))
    record.delivering = record.delivering?.filter((id) => !ids.includes(id))
    const fresh = ids.filter((id) => known.has(id) && !record.consumed.includes(id))
    if (fresh.length) {
      record.consumed.push(...fresh)
      void this.persist(record).catch((cause: unknown) => {
        record.summary.error = String(cause)
        this.changed(record)
      })
    }
  }
  private observeSteering(record: Record, event: DesktopEvent['event']) {
    if (event.type !== 'queue_update') return
    if (event.steering.some((input) => input.submitted)) this.userSteering.add(record)
    else this.userSteering.delete(record)
    for (const listener of this.listeners) listener()
  }
  private event(record: Record, event: DesktopEvent) {
    const current = event.event
    const previousStatus = record.summary.status
    if (current.type === 'message_end' && current.message.role === 'assistant') {
      record.lastAssistant = {
        text: current.message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
        error: current.message.stopReason === 'error' ? current.message.errorMessage || '模型请求失败' : undefined,
      }
    }
    this.acknowledge(record, current)
    this.observeSteering(record, current)
    if (
      current.type === 'extension_ui_request' &&
      ['select', 'input', 'confirm', 'editor', 'questions'].includes(current.method)
    ) {
      record.interactions.push({
        sessionKey: record.summary.sessionKey,
        executionGeneration: record.summary.executionGeneration,
        source: {
          agentId: record.summary.agentId,
          name: record.summary.name,
          rootSessionKey: record.summary.rootSessionKey,
        },
        request: current as PendingInteraction['request'],
      })
      record.summary.status = 'waiting_input'
    }
    if (current.type === 'extension_ui_closed' || current.type === 'extension_ui_timeout') {
      record.interactions = record.interactions.filter((entry) => entry.request.id !== current.id)
      if (!record.interactions.length && record.summary.status === 'waiting_input') record.summary.status = 'running'
    }
    const active = record.session?.getActiveSession()
    if (active?.sessionId) record.summary.sessionId = active.sessionId
    if (active?.sessionFile && record.summary.sessionFile !== active.sessionFile) {
      record.summary.sessionFile = active.sessionFile
      void this.persist(record).catch((cause: unknown) => {
        record.summary.error = String(cause)
        this.changed(record)
      })
    }
    this.emit(record, current)
    if (record.summary.status !== previousStatus) this.changed(record)
  }
  decorateRootEvent(sessionKey: string, event: DesktopEvent): DesktopEvent {
    const root = this.roots.get(sessionKey)
    if (!root) return event
    root.summary.executionGeneration = event.executionGeneration ?? event.generation
    const current = event.event
    const previousStatus = root.summary.status
    this.acknowledge(root, current)
    this.observeSteering(root, current)
    if (
      current.type === 'extension_ui_request' &&
      ['select', 'input', 'confirm', 'editor', 'questions'].includes(current.method)
    ) {
      root.interactions.push({
        sessionKey,
        executionGeneration: root.summary.executionGeneration,
        source: { agentId: root.summary.agentId, name: root.summary.name, rootSessionKey: sessionKey },
        request: current as PendingInteraction['request'],
      })
      root.summary.status = 'waiting_input'
    }
    if (current.type === 'extension_ui_closed' || current.type === 'extension_ui_timeout') {
      root.interactions = root.interactions.filter((entry) => entry.request.id !== current.id)
      if (!root.interactions.length && root.summary.status === 'waiting_input') root.summary.status = 'running'
    }
    if (root.summary.status !== previousStatus) queueMicrotask(() => this.changed(root))
    return {
      ...event,
      executionGeneration: root.summary.executionGeneration,
      agentId: root.summary.agentId,
      rootAgentId: root.summary.rootAgentId,
      runId: root.summary.runId,
    }
  }
  async observeRootEvent(sessionKey: string, event: DesktopEvent) {
    this.decorateRootEvent(sessionKey, event)
  }

  private async settle(record: Record, aborted: boolean) {
    if (!activeStatuses.has(record.summary.status)) return
    const runId = record.summary.runId
    if (record.settled) return
    record.settled = true
    record.waitingMessages = undefined
    const snapshot =
      record.lastAssistant || record.completion || record.session?.connection().status === 'disconnected'
        ? { messages: [] as Snapshot['messages'] }
        : await record.session!.snapshot().catch((cause: unknown) => {
            record.summary.error = String(cause)
            return { messages: [] as Snapshot['messages'] }
          })
    if (runId !== record.summary.runId || !activeStatuses.has(record.summary.status)) return
    record.settled = true
    record.summary.sessionFile = record.session!.getActiveSession().sessionFile
    record.summary.sessionId = record.session!.getActiveSession().sessionId
    const last = snapshot.messages.filter((message) => message.role === 'assistant').at(-1)
    if (!aborted && record.lastAssistant?.error) record.summary.error = record.lastAssistant.error
    const report =
      record.completion?.report ??
      record.lastAssistant?.text ??
      (last?.role === 'assistant'
        ? last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
        : '')
    if (
      !aborted &&
      !record.summary.error &&
      (!record.completion ||
        this.tree(record).some(
          (entry) =>
            this.descendant(record, entry) &&
            entry.delegation?.some((ref) => this.sameRun(record, ref)) &&
            (this.busy(entry) || entry.queued.length > 0),
        ) ||
        this.pending(record).length > 0)
    ) {
      record.summary.status = 'waiting_children'
      await this.persist(record)
      this.changed(record)
      const parent = this.records.get(record.summary.parentAgentId ?? '')
      if (parent && report && !record.feedbackSent) await this.send(record, parent, report)
      await this.summarize(record)
      return
    }
    Object.assign(record.summary, {
      status: aborted ? 'interrupted' : record.summary.error ? 'failed' : 'completed',
      report,
      runCompletedAt: new Date().toISOString(),
    })
    if (record.summary.status === 'failed')
      record.summary.cleanup = { state: 'running', causeId: `result:${record.summary.agentId}:${runId}`, revision: 0 }
    await this.publishResult(record)
    if (record.summary.status === 'completed') await this.startQueued(record)
    else {
      if (record.summary.status === 'failed') {
        const failedRun = this.runRef(record)
        void this.cleanupFailed(record).catch((cause: unknown) => {
          const cleanup = record.summary.cleanup
          if (!this.sameRun(record, failedRun) || !cleanup) return
          record.summary.cleanup = {
            ...cleanup,
            state: 'blocked',
            error: String(cause),
            revision: cleanup.revision + 1,
          }
          this.changed(record)
          void this.persist(record)
            .then(() => this.publishCleanup(record))
            .catch(() => {})
        })
      } else record.queued = []
    }
  }
  private async cleanupFailed(record: Record) {
    record.cleaning = true
    try {
      await this.performFailedCleanup(record)
    } finally {
      record.cleaning = false
    }
  }
  private async performFailedCleanup(record: Record) {
    const failedRun = this.runRef(record)
    if (!failedRun) return
    const affected = this.tree(record).filter(
      (entry) =>
        this.sameRun(entry, failedRun) ||
        entry.delegation?.some(
          (ref) =>
            ref.agentId === failedRun.agentId &&
            ref.runId === failedRun.runId &&
            ref.rootTaskId === failedRun.rootTaskId &&
            ref.epoch === failedRun.epoch,
        ),
    )
    const cancelled: Record[] = []
    const queueNotifications: Array<{ target: Record; message: AgentMailboxMessage }> = []
    for (const entry of affected.reverse()) {
      const cancelledTasks = entry.queued.filter(
        (task) =>
          task.delegation?.some(
            (ref) =>
              ref.agentId === failedRun.agentId &&
              ref.runId === failedRun.runId &&
              ref.rootTaskId === failedRun.rootTaskId &&
              ref.epoch === failedRun.epoch,
          ) ||
          (task.rootTaskId === failedRun.rootTaskId && task.epoch === failedRun.epoch),
      )
      for (const task of cancelledTasks) {
        for (const route of [task.delegation?.[0], task.delegation?.at(-1)]) {
          if (
            !route ||
            queueNotifications.some(
              ({ target, message }) => target.summary.agentId === route.agentId && message.runId === task.runId,
            )
          )
            continue
          const target = this.records.get(route.agentId)
          if (!target) continue
          const id = `result:${entry.summary.agentId}:${task.runId}`
          if (target.mailbox.some((message) => message.id === id) || target.consumed.includes(id)) continue
          const message: AgentMailboxMessage = {
            id,
            fromAgentId: entry.summary.agentId,
            toAgentId: target.summary.agentId,
            rootTaskId: task.rootTaskId,
            epoch: task.epoch,
            runId: task.runId,
            toRunId: route.runId,
            historyOnly: !this.sameRun(target, route),
            causeId: record.summary.cleanup!.causeId,
            kind: 'result',
            status: 'interrupted',
            text: '前置运行失败，排队任务已取消',
            createdAt: new Date().toISOString(),
          }
          target.mailbox.push(message)
          queueNotifications.push({ target, message })
        }
      }
      entry.queued = entry.queued.filter((task) => !cancelledTasks.includes(task))
      entry.pendingStart = undefined
      entry.waitingMessages = undefined
      entry.delivering = undefined
      entry.interactions = []
      if (entry !== record && activeStatuses.has(entry.summary.status)) {
        entry.summary.status = 'interrupted'
        entry.summary.error = '上级任务失败，当前运行已取消'
        entry.summary.runCompletedAt = new Date().toISOString()
        cancelled.push(entry)
      }
    }
    await this.persist(record)
    this.changed(record)
    for (const { target, message } of queueNotifications) {
      this.emit(target, { type: 'agent_mailbox', message })
      if (!message.historyOnly) {
        await this.deliver(target)
        await this.summarize(target)
      }
    }
    for (const entry of cancelled) await this.publishResult(entry)
    const stop = affected.map(async (entry) => {
      const run = this.runRef(entry)
      await Promise.all([
        entry.summary.depth > 0 ? entry.session?.stopAndWait() : undefined,
        run && this.options.stopServicesForRun?.(run),
      ])
      if (entry.summary.depth > 0 && this.sameRun(entry, run) && entry.session) {
        this.callers.delete(entry.session)
        entry.session = undefined
      }
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('子树清理超过 10 秒')), 10000)
    })
    try {
      await Promise.race([Promise.all(stop), timeout])
      if (!this.sameRun(record, failedRun)) return
      record.summary.cleanup = {
        ...record.summary.cleanup!,
        state: 'completed',
        revision: record.summary.cleanup!.revision + 1,
      }
    } catch (cause) {
      record.summary.cleanup = {
        ...record.summary.cleanup!,
        state: 'blocked',
        error: String(cause),
        revision: record.summary.cleanup!.revision + 1,
      }
    } finally {
      clearTimeout(timer)
    }
    await this.persist(record)
    this.changed(record)
    await this.publishCleanup(record)
    if (record.summary.cleanup?.state === 'completed')
      for (const entry of affected) if (entry.queued.length) await this.startQueued(entry, true)
  }
  private async publishCleanup(record: Record) {
    const cleanup = record.summary.cleanup
    if (!cleanup || !record.summary.runId) return
    const notifications: Array<{ target: Record; message: AgentMailboxMessage }> = []
    for (const route of [record.delegation?.[0], record.delegation?.at(-1)]) {
      if (!route || notifications.some(({ target }) => target.summary.agentId === route.agentId)) continue
      const target = this.records.get(route.agentId)
      if (!target) continue
      const message: AgentMailboxMessage = {
        id: `cleanup:${record.summary.agentId}:${record.summary.runId}:${cleanup.revision}`,
        fromAgentId: record.summary.agentId,
        toAgentId: target.summary.agentId,
        rootTaskId: record.summary.rootTaskId,
        epoch: record.summary.epoch,
        runId: record.summary.runId,
        toRunId: route.runId,
        historyOnly: !this.sameRun(target, route),
        causeId: cleanup.causeId,
        kind: 'cleanup',
        status: cleanup.state === 'blocked' ? 'failed' : 'completed',
        text: cleanup.state === 'blocked' ? `子树清理受阻：${cleanup.error ?? '资源状态无法确认'}` : '子树清理完成',
        createdAt: new Date().toISOString(),
      }
      if (target.mailbox.some((item) => item.id === message.id)) continue
      target.mailbox.push(message)
      notifications.push({ target, message })
    }
    await this.persist(record)
    for (const { target, message } of notifications) {
      this.emit(target, { type: 'agent_mailbox', message })
      if (message.historyOnly) continue
      await this.deliver(target)
      await this.summarize(target)
    }
  }
  private async publishResult(record: Record) {
    const runId = record.summary.runId
    if (!runId) return
    const critical = record.summary.status === 'failed' || record.summary.status === 'interrupted'
    const routes = critical ? [record.delegation?.[0], record.delegation?.at(-1)] : [record.delegation?.[0]]
    const notifications: Array<{ target: Record; message: AgentMailboxMessage }> = []
    for (const route of routes) {
      if (
        !route ||
        route.agentId === record.summary.agentId ||
        notifications.some(({ target }) => target.summary.agentId === route.agentId)
      )
        continue
      const target = this.records.get(route.agentId)
      if (!target) continue
      const id = `result:${record.summary.agentId}:${runId}`
      if (target.mailbox.some((message) => message.id === id) || target.consumed.includes(id)) continue
      const message: AgentMailboxMessage = {
        id,
        fromAgentId: record.summary.agentId,
        toAgentId: target.summary.agentId,
        rootTaskId: record.summary.rootTaskId,
        epoch: record.summary.epoch,
        runId,
        toRunId: route.runId,
        historyOnly: !this.sameRun(target, route),
        kind: 'result',
        name: record.summary.name,
        avatar: record.summary.avatar,
        status: record.summary.status,
        startedAt: record.summary.runStartedAt,
        completedAt: record.summary.runCompletedAt,
        text:
          [record.summary.error, record.summary.report].filter(Boolean).join('\n\n') || '子 Agent 已结束，未返回正文',
        createdAt: new Date().toISOString(),
      }
      target.mailbox.push(message)
      notifications.push({ target, message })
    }
    await this.persist(record)
    this.changed(record)
    for (const { target, message } of notifications) {
      this.emit(target, { type: 'agent_mailbox', message })
      if (message.historyOnly) continue
      try {
        await this.deliver(target)
        await this.summarize(target)
      } catch (cause) {
        target.summary.error = String(cause)
        this.changed(target)
      }
    }
  }
  private async startQueued(record: Record, allowCleaning = false) {
    if (this.paused(record) || this.stopping) return
    let next = record.queued.shift()
    let discarded = false
    while (next) {
      const root = this.root(record.summary.rootSessionKey)
      if (
        root.summary.rootTaskId === next.rootTaskId &&
        root.summary.epoch === next.epoch &&
        !['stopped', 'interrupted'].includes(root.summary.status)
      ) {
        this.capacity(root, record)
        await this.start(
          record,
          next.message,
          next.rootTaskId,
          next.epoch,
          next.policy,
          next.runId,
          next.delegation,
          allowCleaning,
        )
        return
      }
      discarded = true
      next = record.queued.shift()
    }
    if (discarded) {
      await this.persist(record)
      this.changed(record)
    }
  }

  private async send(caller: Record, target: Record, text: string) {
    if (!text.trim()) throw new Error('消息不能为空')
    const sameTask =
      target.summary.rootTaskId === caller.summary.rootTaskId && target.summary.epoch === caller.summary.epoch
    const historyOnly = !sameTask || !activeStatuses.has(target.summary.status) || !target.summary.runId
    const message: AgentMailboxMessage = {
      id: randomUUID(),
      fromAgentId: caller.summary.agentId,
      toAgentId: target.summary.agentId,
      rootTaskId: caller.summary.rootTaskId,
      epoch: caller.summary.epoch,
      runId: caller.summary.runId,
      toRunId: target.summary.runId,
      historyOnly,
      kind: 'message',
      text,
      createdAt: new Date().toISOString(),
    }
    target.mailbox.push(message)
    if (!historyOnly) target.completion = undefined
    if (target.summary.agentId === caller.summary.parentAgentId) caller.feedbackSent = true
    await this.persist([caller.summary.rootAgentId, target.summary.rootAgentId])
    const delivered = historyOnly ? false : await this.deliver(target)
    this.emit(target, { type: 'agent_mailbox', message })
    this.changed(target)
    if (!historyOnly) await this.summarize(target)
    return {
      messageId: message.id,
      delivered,
      deliveryState: historyOnly
        ? ('history_only' as const)
        : delivered
          ? ('persisted' as const)
          : ('pending' as const),
    }
  }
  private pending(record: Record) {
    return record.mailbox.filter(
      (message) =>
        !message.historyOnly &&
        message.toRunId === record.summary.runId &&
        message.rootTaskId === record.summary.rootTaskId &&
        message.epoch === record.summary.epoch &&
        !record.consumed.includes(message.id),
    )
  }
  private async deliver(record: Record) {
    if (this.paused(record) || record.settled || record.summary.status !== 'running' || !record.session) return false
    const pending = this.pending(record).filter(
      (message) => !record.waitingMessages?.includes(message.id) && !record.delivering?.includes(message.id),
    )
    if (!pending.length) return false
    const persisted: string[] = []
    for (const message of pending) {
      if (this.paused(record)) return false
      if (
        record.delivering?.includes(message.id) ||
        record.waitingMessages?.includes(message.id) ||
        record.consumed.includes(message.id)
      )
        continue
      record.delivering ??= []
      record.delivering.push(message.id)
      try {
        const ack = await record.session.deliverCollaborationMessage(message)
        if (ack?.persisted) {
          persisted.push(message.id)
          record.delivering = record.delivering?.filter((id) => id !== message.id)
        }
      } catch (cause) {
        record.delivering = record.delivering?.filter((id) => id !== message.id)
        throw cause
      }
    }
    const fresh = persisted.filter((id) => !record.consumed.includes(id))
    if (fresh.length) {
      record.consumed.push(...fresh)
      await this.persist(record)
    }
    return true
  }
  private async summarize(record: Record) {
    if (
      this.paused(record) ||
      record.summary.status !== 'waiting_children' ||
      !record.settled ||
      !record.session ||
      this.stopping
    )
      return
    const pending = this.pending(record).filter(
      (message) => message.rootTaskId === record.summary.rootTaskId && message.epoch === record.summary.epoch,
    )
    if (!pending.length) return
    const epoch = record.summary.epoch
    const rootTaskId = record.summary.rootTaskId
    await Promise.resolve()
    if (
      this.paused(record) ||
      record.summary.status !== 'waiting_children' ||
      record.summary.epoch !== epoch ||
      record.summary.rootTaskId !== rootTaskId
    )
      return
    record.settled = false
    record.summary.status = 'running'
    record.feedbackSent = false
    record.completion = undefined
    const runId = record.summary.runId
    const isCurrent = () => {
      const current =
        record.summary.epoch === epoch &&
        record.summary.rootTaskId === rootTaskId &&
        record.summary.runId === runId &&
        record.summary.status === 'running' &&
        !this.stopping
      if (current && this.paused(record)) {
        record.summary.status = 'waiting_children'
        record.settled = true
        record.consumed = record.consumed.filter((id) => !pending.some((message) => message.id === id))
        this.changed(record)
        return false
      }
      return current
    }
    await this.persist(record)
    if (!isCurrent()) return
    this.changed(record)
    try {
      for (const message of pending) {
        if (!isCurrent()) return
        const ack = await record.session.deliverCollaborationMessage(message)
        if (ack?.persisted === false) throw new Error('来源消息尚未在安全边界保存')
      }
      if (!isCurrent()) return
      record.consumed.push(...pending.map((message) => message.id).filter((id) => !record.consumed.includes(id)))
      await this.persist(record)
      if (!isCurrent()) return
      await record.session.continueCollaborationTask(
        pending.some((message) => message.kind === 'result')
          ? 'A child agent has returned a result. Review the recorded collaboration messages and continue the current task. A returned result is evidence to review, not automatic acceptance.'
          : 'Collaboration feedback has arrived. Continue the current task using the recorded messages. Send and wait again if more feedback is needed. Complete only after the task and any required review criteria are satisfied.',
        record.summary.mode,
      )
    } catch (cause) {
      if (!isCurrent()) return
      record.consumed = record.consumed.filter((id) => !pending.some((message) => message.id === id))
      record.summary.error = String(cause)
      record.summary.status = 'failed'
      record.summary.runCompletedAt = new Date().toISOString()
      record.settled = true
      if (record.summary.depth > 0) {
        record.summary.status = 'running'
        record.settled = false
        await this.settle(record, false)
      } else {
        await this.persist(record)
        this.changed(record)
      }
    }
  }
  private async wait(
    record: Record,
    targets: string[] | undefined,
    timeout = 30000,
    signal: AbortSignal,
  ): Promise<CollaborationResults['wait_agent']> {
    const runId = record.summary.runId
    const current = () => record.summary.runId === runId && activeStatuses.has(record.summary.status)
    const selected = targets?.map((target) => this.target(record, target))
    if (selected?.includes(record)) throw new Error('不能等待自己')
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 3600000)
      throw new Error('等待时长必须在 0 到 3600000 毫秒之间')
    const sources = new Set(this.pending(record).map((message) => message.fromAgentId))
    const watched =
      selected ??
      this.tree(record).filter(
        (entry) => entry !== record && (activeStatuses.has(entry.summary.status) || sources.has(entry.summary.agentId)),
      )
    const runs = new Map(
      watched.map((target) => [target.summary.agentId, target.queued.at(-1)?.runId ?? target.summary.runId]),
    )
    const critical = (message: AgentMailboxMessage) =>
      (message.kind === 'result' && ['failed', 'interrupted'].includes(message.status ?? '')) ||
      (message.kind === 'cleanup' && message.status === 'failed')
    const matches = () =>
      this.pending(record).filter(
        (message) =>
          critical(message) ||
          message.kind === 'cleanup' ||
          watched.some(
            (target) =>
              target.summary.agentId === message.fromAgentId &&
              (message.kind === 'message' || message.runId === runs.get(target.summary.agentId)),
          ),
      )
    const available = () =>
      !current() ||
      this.userSteering.has(record) ||
      matches().length > 0 ||
      watched.some(
        (target) =>
          !this.descendant(target, record) &&
          ((target.summary.runId === runs.get(target.summary.agentId) && !activeStatuses.has(target.summary.status)) ||
            (['stopped', 'interrupted'].includes(target.summary.status) &&
              !target.queued.some((task) => task.runId === runs.get(target.summary.agentId)))),
      )
    let timedOut = timeout === 0 && !available()
    const previous = record.summary.status
    record.summary.status = 'waiting_children'
    this.changed(record)
    try {
      if (!available() && timeout > 0)
        await new Promise<void>((resolve, reject) => {
          let timer: NodeJS.Timeout
          let check: () => void
          let abort: () => void
          const cleanup = () => {
            clearTimeout(timer)
            this.listeners.delete(check)
            signal.removeEventListener('abort', abort)
          }
          check = () => {
            if (available()) {
              cleanup()
              resolve()
            }
          }
          abort = () => {
            cleanup()
            reject(new Error('等待已取消'))
          }
          timer = setTimeout(() => {
            timedOut = true
            cleanup()
            resolve()
          }, timeout)
          this.listeners.add(check)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
          else check()
        })
      if (!current()) throw new Error('等待所属任务已结束或更换')
      const matched = matches()
      const messages = matched.filter((message) => !record.delivering?.includes(message.id))
      const notifiedBy = [
        ...new Set(
          matched.filter((message) => record.delivering?.includes(message.id)).map((message) => message.fromAgentId),
        ),
      ]
      record.waitingMessages = [
        ...new Set([...(record.waitingMessages ?? []), ...messages.map((message) => message.id)]),
      ]
      await this.persist(record)
      const endedTarget = watched.some(
        (target) =>
          target.summary.runId === runs.get(target.summary.agentId) && !activeStatuses.has(target.summary.status),
      )
      const wakeReason = this.userSteering.has(record)
        ? ('user_steering' as const)
        : matched.some(critical)
          ? ('critical' as const)
          : matched.some((message) => message.kind === 'cleanup')
            ? ('cleanup' as const)
            : matched.some((message) => message.kind === 'result') || endedTarget
              ? ('result' as const)
              : matched.length
                ? ('message' as const)
                : ('timeout' as const)
      return {
        agents: [
          ...new Set([
            ...(selected ?? this.tree(record)),
            ...matched
              .map((message) => this.records.get(message.fromAgentId))
              .filter((entry): entry is Record => Boolean(entry)),
          ]),
        ].map((entry) => ({ ...entry.summary })),
        messages,
        timedOut: timedOut && !matched.length,
        wakeReason,
        ...(notifiedBy.length ? { notifiedBy } : {}),
      }
    } finally {
      if (current() && record.summary.status === 'waiting_children') record.summary.status = previous
      this.changed(record)
    }
  }
  private async interrupt(record: Record, wholeTree = false) {
    if (!wholeTree && record.summary.status === 'failed' && record.summary.cleanup?.state === 'blocked') {
      record.summary.cleanup = { ...record.summary.cleanup, state: 'running', error: undefined }
      await this.persist(record)
      await this.cleanupFailed(record)
      return
    }
    const run = this.runRef(record)
    const descendants = this.tree(record)
      .filter(
        (entry) =>
          this.descendant(record, entry) &&
          (wholeTree ||
            entry.delegation?.some(
              (ref) =>
                ref.agentId === run?.agentId &&
                ref.runId === run?.runId &&
                ref.rootTaskId === run?.rootTaskId &&
                ref.epoch === run?.epoch,
            )),
      )
      .reverse()
    const terminated: Record[] = []
    for (const child of [...descendants, record]) {
      this.userSteering.delete(child)
      child.queued = []
      child.pendingStart = undefined
      child.waitingMessages = undefined
      child.delivering = undefined
      child.summary.isPaused = false
      const wasPaused = child.pauseApplied
      child.pauseApplied = false
      if (!activeStatuses.has(child.summary.status) && !(wholeTree && child === record)) {
        if (wasPaused) await child.session?.abort().catch(() => {})
        continue
      }
      child.summary.status = wholeTree && child === record ? 'stopped' : 'interrupted'
      child.summary.runCompletedAt = new Date().toISOString()
      child.summary.cleanup = {
        state: 'running',
        causeId: `result:${child.summary.agentId}:${child.summary.runId}`,
        revision: 0,
      }
      child.interactions = []
      terminated.push(child)
    }
    await this.persist(record)
    for (const child of terminated) await this.publishResult(child)
    const results = await Promise.allSettled(
      terminated.map(async (child) => {
        const childRun = this.runRef(child)
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            Promise.all([
              child.summary.depth > 0 ? child.session?.stopAndWait() : child.session?.abort(),
              child.summary.depth > 0 && childRun && this.options.stopServicesForRun?.(childRun),
            ]),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('运行清理超过 10 秒')), 10000)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
        if (child.summary.depth > 0 && this.sameRun(child, childRun) && child.session) {
          this.callers.delete(child.session)
          child.session = undefined
        }
      }),
    )
    for (let index = 0; index < terminated.length; index++) {
      const child = terminated[index]!
      const result = results[index]!
      child.summary.cleanup = {
        ...child.summary.cleanup!,
        state: result.status === 'fulfilled' ? 'completed' : 'blocked',
        revision: child.summary.cleanup!.revision + 1,
        ...(result.status === 'rejected' ? { error: String(result.reason) } : {}),
      }
    }
    await this.persist(record)
    this.changed(record)
    for (const child of terminated) await this.publishCleanup(child)
  }
  async stopRoot(sessionKey: string) {
    await this.ready
    const root = this.root(sessionKey)
    root.pauseRequested = true
    root.pauseRevision = (root.pauseRevision ?? 0) + 1
    await this.interrupt(root, true)
    root.pauseRequested = false
    root.summary.status = 'stopped'
    await this.settlePlan(root)
    await this.persist(root)
    this.changed(root)
  }
  async interruptAgent(agentId: string) {
    await this.ready
    const record = this.records.get(agentId)
    if (!record) throw new Error('Agent 不存在')
    await this.interrupt(record)
  }
  async snapshot(sessionKey: string) {
    await this.ready
    const root = this.root(sessionKey)
    const tree = this.tree(root)
    const { planCheckpoints, planState } = root.session
      ? await this.readPlanSnapshot(root.session)
      : { planCheckpoints: await this.readPlanCheckpoints(root), planState: undefined }
    return {
      planState,
      planCheckpoints,
      agent: { ...root.summary },
      agents: tree.map((entry) => ({ ...entry.summary })),
      planDocuments: planState?.document ? [planState.document] : [],
      pendingInteractions: tree.flatMap((entry) => entry.interactions),
      agentMessages: tree.flatMap((entry) => entry.mailbox),
    }
  }
  async prepareEdit(sessionKey: string) {
    await this.ready
    const root = this.root(sessionKey)
    if (this.tree(root).some((record) => this.busy(record) || record.queued.length || record.interactions.length))
      throw new Error('子任务尚未完成清理，无法覆盖历史')
  }
  async historyEdited(actualSession: RuntimeSdkSession) {
    await this.ready
    const root = this.callers.get(actualSession)
    if (!root || root.session !== actualSession || root.summary.depth !== 0)
      throw new Error('历史编辑必须来自已绑定的根会话')
    const { entries, leafId } = await actualSession.getEntries()
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    const retained = new Set<string>()
    const agents = new Set<string>()
    const messages = new Set<string>()
    const calls = new Set<string>()
    const read = (value: unknown) => {
      if (!value || typeof value !== 'object') return
      const details = value as {
        agentId?: string
        fromAgentId?: string
        messageId?: string
        agent?: unknown
        agents?: unknown[]
        messages?: Array<{ id: string }>
      }
      if (details.agentId) agents.add(details.agentId)
      if (details.fromAgentId) agents.add(details.fromAgentId)
      if (details.messageId) messages.add(details.messageId)
      if (details.agent) read(details.agent)
      if (Array.isArray(details.agents)) details.agents.forEach(read)
      if (Array.isArray(details.messages)) for (const message of details.messages) messages.add(message.id)
    }
    let entry = leafId ? byId.get(leafId) : undefined
    while (entry && !retained.has(entry.id)) {
      retained.add(entry.id)
      if (entry.type === 'custom_message' && entry.customType === 'pi-meme-collaboration') read(entry.details)
      if (entry.type === 'message' && entry.message.role === 'toolResult') {
        calls.add(entry.message.toolCallId)
        for (const call of entry.message.nestedCalls?.calls ?? []) calls.add(call.id)
        read(entry.message.details)
      }
      entry = entry.parentId ? byId.get(entry.parentId) : undefined
    }
    for (const reply of root.replies ?? []) if (calls.has(reply.id)) read(reply.result)
    const removed = this.tree(root).filter(
      (record) =>
        record !== root &&
        (record.sourceEntryId
          ? !retained.has(record.sourceEntryId)
          : !agents.has(record.importedAgentId ?? record.summary.agentId)),
    )
    if (removed.some((record) => this.busy(record) || record.queued.length || record.interactions.length))
      throw new Error('被覆盖的子任务尚未完成清理')
    // 先释放 Worker 并删除子会话；失败时保留身份，避免子会话被普通历史列表误收录。
    for (const record of removed) {
      await record.session?.stopAndWait()
      if (record.summary.sessionFile) {
        await rm(record.summary.sessionFile, { force: true })
        await rm(`${record.summary.sessionFile}.changes`, { recursive: true, force: true })
      }
    }
    const removedIds = new Set(removed.map((record) => record.summary.agentId))
    for (const record of removed) {
      if (record.session) this.callers.delete(record.session)
      record.session = undefined
      record.summary.executionGeneration += 1
      this.records.delete(record.summary.agentId)
    }
    for (const record of this.tree(root)) {
      record.mailbox = record.mailbox.filter(
        (message) =>
          !removedIds.has(message.fromAgentId) &&
          !removedIds.has(message.toAgentId) &&
          (record !== root || messages.has(message.id)),
      )
      const mailboxIds = new Set(record.mailbox.map((message) => message.id))
      record.consumed = record.consumed.filter((id) => mailboxIds.has(id))
      record.waitingMessages = record.waitingMessages?.filter((id) => mailboxIds.has(id))
      record.delivering = record.delivering?.filter((id) => mailboxIds.has(id))
      if (record === root) record.replies = record.replies?.filter((reply) => calls.has(reply.id))
    }
    await this.persist(root)
    this.emit(root, {
      type: 'agents_update',
      agents: this.tree(root).map((record) => ({ ...record.summary })),
      agentMessages: this.tree(root).flatMap((record) => record.mailbox),
    })
    for (const listener of this.listeners) listener()
  }
  async getChildSessions() {
    await this.ready
    return this.childSessionIdentities()
  }
  childSessionIdentities() {
    return [...this.records.values()]
      .filter((record) => record.summary.depth > 0)
      .map((record) => ({ sessionId: record.summary.sessionId, sessionFile: record.summary.sessionFile }))
  }
  async getAgents(sessionKey: string) {
    return (await this.snapshot(sessionKey)).agents
  }
  rootSessionKey(agentIdOrSessionKey: string): string | undefined {
    const agentId = agentIdOrSessionKey.startsWith('agent:') ? agentIdOrSessionKey.slice(6) : agentIdOrSessionKey
    const direct = this.records.get(agentId)
    if (direct?.summary.rootSessionKey) return direct.summary.rootSessionKey
    for (const record of this.records.values()) {
      if (record.summary.sessionKey === agentIdOrSessionKey || record.summary.agentId === agentId) {
        return record.summary.rootSessionKey
      }
    }
    for (const root of this.roots.values()) {
      if (root.summary.sessionKey === agentIdOrSessionKey || root.summary.agentId === agentId) {
        return root.summary.rootSessionKey
      }
    }
    return undefined
  }

  async getAgentSnapshot(agentId: string): Promise<Snapshot> {
    await this.ready
    const record = this.records.get(agentId)
    if (!record) throw new Error('Agent 不存在')
    if (!record.summary.conversationOrigin && record.summary.parentAgentId && record.summary.sessionFile) {
      const origin = await inferAgentConversationOrigin(record.summary.sessionFile, record.summary.parentAgentId)
      if (origin) {
        record.summary.conversationOrigin = origin
        if (record.session?.connection().status === 'ready')
          await record.session.configureAgentTask(record.summary.task ?? '', origin)
        await this.persist(record)
      }
    }
    if (!record.session || record.session.connection().status !== 'ready') {
      const history = record.summary.sessionFile ? await readSessionHistory(record.summary.sessionFile) : undefined
      const own =
        record.summary.conversationOrigin && record.summary.sessionFile
          ? await readAgentConversation(record.summary.sessionFile, record.summary.conversationOrigin)
          : undefined
      return {
        connection: {
          cwd: record.summary.cwd,
          generation: record.summary.executionGeneration,
          sessionKey: record.summary.sessionKey,
          status: 'idle',
        },
        state: {
          mode: record.summary.mode,
          model: record.summary.model,
          thinkingLevel: record.summary.thinkingLevel,
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'one-at-a-time',
          pendingMessageCount: 0,
          skillUsages: own?.skillUsages ?? history?.skillUsages,
        },
        messages: own?.messages ?? history?.messages ?? [],
        models: [],
        sessionEntries: own?.sessionEntries ?? history?.sessionEntries,
        eventSequence: record.sequence,
        events: [],
        agent: { ...record.summary },
        agents: this.tree(record).map((entry) => ({ ...entry.summary })),
        pendingInteractions: [],
        planDocuments: [],
      }
    }
    const sequence = record.sequence
    const snapshot = await record.session.snapshot()
    return {
      ...snapshot,
      connection: {
        ...snapshot.connection,
        generation: record.summary.executionGeneration,
        sessionKey: record.summary.sessionKey,
      },
      eventSequence: sequence,
      events: record.events ?? [],
      agent: { ...record.summary },
      agents: this.tree(record).map((entry) => ({ ...entry.summary })),
      pendingInteractions: record.interactions,
      planDocuments: [],
    }
  }
  async respondExtensionUI(
    sessionKey: string,
    id: string,
    response: Parameters<RuntimeSdkSession['respondExtensionUI']>[1],
  ) {
    const record = [...this.records.values()].find((entry) => entry.summary.sessionKey === sessionKey)
    const pending = record?.interactions.find((entry) => entry.request.id === id)
    const answerKey = JSON.stringify([sessionKey, pending?.executionGeneration, id])
    if (!record?.session || !pending || this.answers.has(answerKey)) throw new Error('子 Agent 交互已回答或已结束')
    validateExtensionDialogResponse(pending.request, response)
    this.answers.add(answerKey)
    try {
      await record.session.respondExtensionUI(id, response)
      if (record.interactions.includes(pending))
        this.event(record, {
          generation: pending.executionGeneration,
          event: { type: 'extension_ui_closed', id, reason: 'answered' },
        })
      this.changed(record)
    } finally {
      this.answers.delete(answerKey)
    }
  }

  async resolvePlan(actualSession: RuntimeSdkSession, reference: PlanRef, signal: AbortSignal): Promise<PlanDocument> {
    await this.ready
    const record = this.callers.get(actualSession)
    if (!record || record.session !== actualSession || record.summary.depth !== 0 || this.stopping || signal.aborted)
      throw new Error('计划操作已取消或不是根会话')
    const state = await this.syncPlan(actualSession)
    const document = state.document?.id === reference.id ? state.document : undefined
    if (!document) throw new Error('当前会话不存在此计划')
    if (document.revision !== reference.revision) throw new Error('计划已有新修订，请刷新后重试')
    return { ...document }
  }

  private async settlePlan(record: Record) {
    const sessionId = record.session?.getActiveSession().sessionId ?? record.summary.sessionId
    if (
      record.session &&
      sessionId &&
      (this.pendingPlans.has(sessionId) ||
        this.planStates.has(sessionId) ||
        this.plans.some((plan) => plan.sessionId === sessionId))
    )
      await this.syncPlan(record.session, true)
  }

  markTemporarySession(sessionIdOrKey: string, rootAgentId?: string) {
    this.temporarySessions.add(sessionIdOrKey)
    if (rootAgentId) this.temporaryRoots.add(rootAgentId)
  }

  isTemporarySession(sessionId?: string): boolean {
    if (!sessionId) return false
    if (this.temporarySessions.has(sessionId)) return true
    for (const root of this.roots.values()) {
      if (this.temporaryRoots.has(root.summary.rootAgentId)) {
        if (
          root.summary.sessionId === sessionId ||
          root.summary.rootSessionKey === sessionId ||
          root.summary.sessionKey === sessionId
        ) {
          this.temporarySessions.add(sessionId)
          return true
        }
      }
    }
    for (const record of this.records.values()) {
      if (this.temporaryRoots.has(record.summary.rootAgentId)) {
        if (record.summary.sessionId === sessionId || record.summary.sessionKey === sessionId) {
          this.temporarySessions.add(sessionId)
          return true
        }
      }
    }
    return false
  }

  private persistPlans() {
    const persistentPlans = this.plans.filter(
      (p) => !this.isTemporarySession(p.sessionId) && !this.temporarySessions.has(p.sessionId),
    )
    const persistentStates = [...this.planStates.values()].filter(
      (s) => !this.isTemporarySession(s.sessionId) && !this.temporarySessions.has(s.sessionId),
    )
    const write = this.planIndexWrites.then(() =>
      saveCollaborationPlans(this.plansFile, persistentPlans, persistentStates),
    )
    this.planIndexWrites = write.catch(() => {})
    return write
  }

  private async readPlanCheckpoints(record: Record): Promise<PlanCheckpoint[]> {
    if (record.session?.connection().status === 'ready') {
      return record.session.getPlanCheckpoints()
    }
    if (!record.summary.sessionFile) return []
    try {
      return (await readSessionHistory(record.summary.sessionFile)).planCheckpoints ?? []
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw cause
    }
  }

  async syncPlan(actualSession: RuntimeSdkSession, force = false): Promise<PlanState> {
    return (await this.readPlanSnapshot(actualSession, force)).planState
  }

  private readPlanSnapshot(actualSession: RuntimeSdkSession, force = false) {
    const pending = this.planWrites.then(async () => {
      await this.ready
      const record = this.callers.get(actualSession)
      if (!record || record.session !== actualSession || record.summary.depth !== 0)
        throw new Error('计划状态只能由当前根会话同步')
      const planCheckpoints = await this.readPlanCheckpoints(record)
      return { planCheckpoints, planState: await this.syncPlanOnce(record, planCheckpoints, force) }
    })
    this.planWrites = pending.then(
      () => {},
      () => {},
    )
    return pending
  }

  private async syncPlanOnce(record: Record, checkpoints: PlanCheckpoint[], force = false): Promise<PlanState> {
    const sessionId = record.session?.getActiveSession().sessionId ?? record.summary.sessionId
    if (!sessionId) return { sessionId: '', revision: 0 }
    const previous = this.planStates.get(sessionId)
    const checkpoint = checkpoints.at(-1)
    const candidate = this.pendingPlans.get(sessionId)
    const committed =
      candidate &&
      checkpoints.some((item) => item.document.id === candidate.id && item.document.revision === candidate.revision)
    // 工具结果落盘前，候选文件不能覆盖对外的有效方案。
    if (candidate && !committed && !force) return previous ?? { sessionId, revision: 0 }
    const indexed = this.plans.filter((plan) => plan.sessionId === sessionId)
    const indexMatches = previous?.document
      ? indexed.length === 1 &&
        indexed[0]?.id === previous.document.id &&
        indexed[0]?.revision === previous.document.revision &&
        indexed[0]?.markdown === previous.document.markdown
      : indexed.length === 0
    if (
      !candidate &&
      indexMatches &&
      previous?.sourceEntryId === checkpoint?.sourceEntryId &&
      previous?.document?.markdown === checkpoint?.document.markdown &&
      previous?.document?.title === checkpoint?.document.title &&
      previous
    ) {
      return previous
    }
    const existing = this.plans.filter((plan) => plan.sessionId === sessionId)
    if (!previous && !checkpoint && !existing.length) return { sessionId, revision: 0 }
    const revision = Math.max(
      (previous?.revision ?? 0) + 1,
      ...existing.map((plan) => plan.revision + (committed ? 0 : 1)),
      checkpoint?.document.revision ?? 0,
    )
    const document = checkpoint
      ? {
          ...checkpoint.document,
          id:
            previous?.document?.id ??
            (checkpoint.document.sessionId === sessionId ? checkpoint.document.id : randomUUID()),
          sessionId,
          revision:
            committed && candidate && checkpoint.document.revision === candidate.revision
              ? candidate.revision
              : revision,
        }
      : undefined
    const state: PlanState = { sessionId, revision, document, sourceEntryId: checkpoint?.sourceEntryId }
    const isTemp = this.isTemporarySession(sessionId)
    const priorPlans = this.plans
    const file = !isTemp && document ? path.join(this.plansDirectory, sessionId, `${document.id}.md`) : undefined
    const temporary = file && `${file}.${randomUUID()}.tmp`
    try {
      if (document && file && temporary) {
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(temporary, document.markdown, { mode: 0o600 })
        await rename(temporary, file)
      }
      this.plans = [...this.plans.filter((plan) => plan.sessionId !== sessionId), ...(document ? [document] : [])]
      this.planStates.set(sessionId, state)
      await this.persistPlans()
    } catch (cause) {
      this.plans = priorPlans
      if (previous) this.planStates.set(sessionId, previous)
      else this.planStates.delete(sessionId)
      throw cause
    } finally {
      if (temporary) await rm(temporary, { force: true })
    }
    this.pendingPlans.delete(sessionId)
    this.planCommits.get(sessionId)?.resolve()
    this.planCommits.delete(sessionId)
    this.emit(record, { type: 'plan_state_changed', state, reason: committed ? 'saved' : 'restored' })
    return state
  }
  async resolveSessionPlan(sessionKey: string, reference: PlanRef): Promise<PlanDocument> {
    await this.ready
    const session = this.root(sessionKey).session
    if (!session) throw new Error('计划会话尚未绑定')
    return this.resolvePlan(session, reference, new AbortController().signal)
  }

  async savePlan(actualSession: RuntimeSdkSession, input: SavePlanInput, signal: AbortSignal): Promise<PlanDocument> {
    const pending = (this.planSaves.get(actualSession) ?? Promise.resolve()).then(() => {
      const write = this.planWrites.then(() => this.savePlanOnce(actualSession, input, signal))
      this.planWrites = write.then(
        () => {},
        () => {},
      )
      return write
    })
    this.planSaves.set(
      actualSession,
      pending
        .then((document) => this.planCommits.get(document.sessionId)?.promise)
        .then(
          () => {},
          () => {},
        ),
    )
    return pending
  }
  private async savePlanOnce(
    actualSession: RuntimeSdkSession,
    input: SavePlanInput,
    signal: AbortSignal,
  ): Promise<PlanDocument> {
    await this.ready
    const record = this.caller(actualSession)
    if (record.summary.depth !== 0 || record.summary.mode !== 'plan' || !record.summary.runId)
      throw new Error('只有规划模式根 Agent 可以保存计划')
    if (signal.aborted) throw new Error('计划保存已取消')
    if (
      this.tree(record).some(
        (entry) => entry !== record && (activeStatuses.has(entry.summary.status) || entry.queued.length > 0),
      ) ||
      this.pending(record).some((message) => message.kind === 'result')
    )
      throw new Error('子 Agent 尚未全部结束或结果尚未读取，请先调用 wait_agent')
    const sessionId = actualSession.getActiveSession().sessionId
    if (!sessionId || !/^[\w-]+$/.test(sessionId)) throw new Error('Pi 会话身份尚未保存')
    if (!input.title.trim() || !input.markdown.trim()) throw new Error('计划标题和正文不能为空')
    await this.syncPlanOnce(record, await this.readPlanCheckpoints(record))
    if (this.pendingPlans.has(sessionId)) throw new Error('上一份计划尚未写入会话，请等待保存完成')
    const existing = this.planStates.get(sessionId)?.document
    if (
      input.reference &&
      (!existing || (existing.runId !== record.summary.runId && existing.revision !== input.reference.revision))
    )
      throw new Error('计划已有新修订，请刷新后重新调整')
    const document: PlanDocument = {
      id: existing?.id ?? randomUUID(),
      sessionId,
      runId: record.summary.runId,
      revision: Math.max(existing?.revision ?? 0, this.planStates.get(sessionId)?.revision ?? 0) + 1,
      title: input.title.trim(),
      markdown: input.markdown,
      updatedAt: new Date().toISOString(),
    }
    const runId = record.summary.runId
    const assertCurrent = () => {
      if (signal.aborted || runId !== record.summary.runId || !activeStatuses.has(record.summary.status))
        throw new Error('计划保存轮次已取消或更换')
    }
    const isTemp =
      this.temporaryRoots.has(record.summary.rootAgentId) ||
      this.isTemporarySession(sessionId) ||
      this.isTemporarySession(record.summary.rootSessionKey)
    if (isTemp) {
      this.temporarySessions.add(sessionId)
      this.temporaryRoots.add(record.summary.rootAgentId)
    }
    const directory = path.join(this.plansDirectory, sessionId)
    const file = path.join(directory, `${document.id}.md`)
    const temporary = `${file}.${randomUUID()}.tmp`
    let replaced = false
    let metadataChanged = false
    const isNewDocument = !existing
    try {
      if (!isTemp) {
        await mkdir(directory, { recursive: true })
        assertCurrent()
        await writeFile(temporary, document.markdown, { mode: 0o600 })
        assertCurrent()
        await rename(temporary, file)
        replaced = true
      }
      assertCurrent()
      if (existing) this.plans[this.plans.indexOf(existing)] = document
      else this.plans.push(document)
      metadataChanged = true
      record.summary.sessionId = sessionId
      const saveIndex = this.planIndexWrites.then(async () => {
        const persistentPlans = this.plans.filter((p) => !this.isTemporarySession(p.sessionId))
        const persistentStates = [...this.planStates.values()].filter((s) => !this.isTemporarySession(s.sessionId))
        await saveCollaborationPlans(this.plansFile, persistentPlans, persistentStates)
      })
      this.planIndexWrites = saveIndex.catch(() => {})
      await saveIndex
      await this.persist(record.summary.rootAgentId)
      assertCurrent()
    } catch (cause) {
      if (metadataChanged) {
        if (existing) this.plans[this.plans.indexOf(document)] = existing
        else this.plans = this.plans.filter((plan) => plan !== document)
        const saveIndex = this.planIndexWrites.then(async () => {
          const persistentPlans = this.plans.filter((p) => !this.isTemporarySession(p.sessionId))
          const persistentStates = [...this.planStates.values()].filter((s) => !this.isTemporarySession(s.sessionId))
          await saveCollaborationPlans(this.plansFile, persistentPlans, persistentStates)
        })
        this.planIndexWrites = saveIndex.catch(() => {})
        await saveIndex.catch(() => {})
      }
      if (replaced) {
        if (existing) {
          await writeFile(temporary, existing.markdown, { mode: 0o600 })
          await rename(temporary, file)
        } else if (isNewDocument) {
          await rm(file, { force: true })
        }
      }
      if (metadataChanged) await this.persist(record.summary.rootAgentId)
      throw cause
    } finally {
      if (!isTemp) await rm(temporary, { force: true }).catch(() => {})
    }
    this.pendingPlans.set(sessionId, document)
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    this.planCommits.set(sessionId, { promise, resolve })
    return document
  }
  async retireSessions(sessionKeys: string[]) {
    await this.ready
    const matched = [...this.records.values()].filter((record) => sessionKeys.includes(record.summary.sessionKey))
    const roots = new Set(matched.map((record) => record.summary.rootSessionKey))
    for (const key of roots) {
      const tree = this.tree(this.root(key))
      while (
        tree.some(
          (record) =>
            activeStatuses.has(record.summary.status) || record.queued.length > 0 || record.interactions.length,
        )
      )
        await new Promise<void>((resolve) => {
          const wake = () => {
            this.listeners.delete(wake)
            resolve()
          }
          this.listeners.add(wake)
        })
      for (const record of tree)
        if (record.summary.depth > 0) {
          await record.session?.stopAndWait()
          record.session = undefined
        }
    }
  }
  async waitForIdle() {
    await this.ready
    while (
      [...this.records.values()].some((record) => activeStatuses.has(record.summary.status) || record.queued.length > 0)
    )
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.listeners.delete(wake)
          resolve()
        }
        this.listeners.add(wake)
      })
  }
  async deleteTemporarySessions(targets: {
    sessionIds?: string[]
    sessionFiles?: string[]
    sessionKeys?: string[]
    rootAgentIds?: string[]
  }): Promise<{ deletedRootAgentIds: string[] }> {
    await this.ready
    const targetSessionIds = new Set((targets.sessionIds ?? []).filter(Boolean))
    const targetSessionFiles = new Set((targets.sessionFiles ?? []).filter(Boolean))
    const targetSessionKeys = new Set((targets.sessionKeys ?? []).filter(Boolean))
    const targetRootAgentIds = new Set((targets.rootAgentIds ?? []).filter(Boolean))
    const deletedRootAgentIds: string[] = []

    const matchedRoots: Array<{ key: string; root: Record; tree: Record[] }> = []
    for (const [key, root] of [...this.roots.entries()]) {
      const rootSessionId = root.summary.sessionId
      const rootSessionFile = root.summary.sessionFile
      const rootAgentId = root.summary.rootAgentId
      const matchesSessionId = Boolean(rootSessionId && targetSessionIds.has(rootSessionId))
      const matchesSessionFile = Boolean(rootSessionFile && targetSessionFiles.has(rootSessionFile))
      const matchesSessionKey =
        targetSessionKeys.has(root.summary.sessionKey) ||
        (rootSessionId && targetSessionKeys.has(rootSessionId)) ||
        targetSessionIds.has(root.summary.sessionKey)
      const matchesRootAgentId = targetRootAgentIds.has(rootAgentId)

      if (!matchesSessionId && !matchesSessionFile && !matchesSessionKey && !matchesRootAgentId) {
        continue
      }

      matchedRoots.push({ key, root, tree: this.tree(root) })
    }

    for (const { root, tree } of matchedRoots) {
      await this.stopRoot(root.summary.rootSessionKey)
      for (const entry of tree) {
        if (entry.session) await entry.session.stopAndWait()
      }
    }

    for (const { key, root, tree } of matchedRoots) {
      const rootSessionId = root.summary.sessionId
      const rootAgentId = root.summary.rootAgentId
      for (const entry of tree) {
        this.records.delete(entry.summary.agentId)
        if (entry.session) {
          this.callers.delete(entry.session)
        }
      }
      this.roots.delete(key)
      if (root.summary.rootSessionKey) {
        this.roots.delete(root.summary.rootSessionKey)
      }
      this.temporaryRoots.delete(rootAgentId)
      const sessionIdsToPurge = new Set<string>()
      if (rootSessionId) sessionIdsToPurge.add(rootSessionId)
      try {
        const nativeSessionId = root.session ? (root.session as any).getActiveSession?.()?.sessionId : undefined
        if (nativeSessionId) sessionIdsToPurge.add(nativeSessionId)
      } catch {}
      for (const entry of tree) {
        this.temporarySessions.delete(entry.summary.sessionKey)
        this.temporarySessions.delete(entry.summary.rootSessionKey)
        if (entry.summary.sessionId) sessionIdsToPurge.add(entry.summary.sessionId)
        try {
          const entryNative = entry.session ? (entry.session as any).getActiveSession?.()?.sessionId : undefined
          if (entryNative) sessionIdsToPurge.add(entryNative)
        } catch {}
      }
      for (const sid of sessionIdsToPurge) {
        targetSessionIds.add(sid)
      }
      await deleteCollaborationRoot(this.rootsDirectory, rootAgentId).catch(() => {})
      deletedRootAgentIds.push(rootAgentId)
    }

    for (const sid of targetSessionIds) {
      this.plans = this.plans.filter((p) => p.sessionId !== sid)
      this.planStates.delete(sid)
      this.pendingPlans.delete(sid)
      this.planCommits.get(sid)?.resolve()
      this.planCommits.delete(sid)
      await rm(path.join(this.plansDirectory, sid), { recursive: true, force: true }).catch(() => {})
      this.temporarySessions.delete(sid)
    }

    await this.persistPlans()
    return { deletedRootAgentIds }
  }

  async deleteSessions(targets: {
    sessionIds: string[]
    sessionFiles: string[]
    destroyTemporary?: boolean
  }): Promise<{ deletedRootAgentIds: string[] }> {
    if (targets.destroyTemporary) {
      return this.deleteTemporarySessions(targets)
    }
    await this.ready
    const targetSessionIds = new Set(targets.sessionIds.filter(Boolean))
    const targetSessionFiles = new Set(targets.sessionFiles.filter(Boolean))
    const deletedRootAgentIds: string[] = []

    for (const [key, root] of [...this.roots.entries()]) {
      const rootSessionId = root.summary.sessionId
      const rootSessionFile = root.summary.sessionFile
      const matchesSessionId = Boolean(rootSessionId && targetSessionIds.has(rootSessionId))
      const matchesSessionFile = Boolean(rootSessionFile && targetSessionFiles.has(rootSessionFile))
      const matchesSessionKey =
        targets.sessionIds.includes(root.summary.sessionKey) || targets.sessionFiles.includes(root.summary.sessionKey)

      if (!matchesSessionId && !matchesSessionFile && !matchesSessionKey) {
        continue
      }

      const tree = this.tree(root)
      const hasRetainedHistory = tree.some((entry) => {
        if (entry.summary.depth > 0) {
          if (entry.summary.sessionFile && !targetSessionFiles.has(entry.summary.sessionFile)) return true
          if (entry.summary.sessionId && !targetSessionIds.has(entry.summary.sessionId)) return true
        }
        if (entry.replies && entry.replies.length > 0) return true
        if (entry.mailbox && entry.mailbox.length > 0) return true
        return false
      })

      // 检查该根会话是否有计划文档
      const hasPlans = this.plans.some((p) => p.sessionId === rootSessionId)

      if (hasRetainedHistory || hasPlans) {
        // 保留该根记录，仅停止其运行状态，使 childSessionIdentities 仍能有效隐藏子会话，去重和通信历史不丢
        await this.stopRoot(root.summary.rootSessionKey)
        continue
      }

      // 无保留引用的整根：停止运行、清理内存记录、删除分片文件
      await this.stopRoot(root.summary.rootSessionKey)
      for (const entry of tree) {
        this.records.delete(entry.summary.agentId)
        if (entry.session) {
          this.callers.delete(entry.session)
        }
      }
      this.roots.delete(key)
      if (root.summary.rootSessionKey) {
        this.roots.delete(root.summary.rootSessionKey)
      }
      await deleteCollaborationRoot(this.rootsDirectory, root.summary.rootAgentId)
      deletedRootAgentIds.push(root.summary.rootAgentId)
    }

    return { deletedRootAgentIds }
  }
  async stopAndWait() {
    this.stopping = true
    await this.ready
    for (const root of this.roots.values()) await this.stopRoot(root.summary.rootSessionKey)
    await Promise.all(
      [...this.records.values()]
        .filter((record) => record.summary.depth > 0)
        .map((record) => record.session?.stopAndWait()),
    )
    await Promise.allSettled([
      ...this.inFlight.values(),
      this.planWrites,
      this.planIndexWrites,
      ...this.rootWrites.values(),
    ])
  }
}
