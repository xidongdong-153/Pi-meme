import { validateExtensionDialogResponse } from '@pi-meme/contracts/user-input'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { DesktopEvent, Snapshot } from '@pi-meme/contracts/desktop'
import {
  collaborationLimits,
  type AgentSummary,
  type AgentMailboxMessage,
  type CollaborationRequest,
  type CollaborationResults,
  type PendingInteraction,
} from '@pi-meme/contracts/collaboration'
import type { PlanDocument, SavePlanInput, TaskMode } from '@pi-meme/contracts/plan'
import type { PiState } from '@pi-meme/contracts/pi'
import type { RuntimeSdkSession } from '@pi-meme/pi-runtime/session-pool'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import { loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'
import { readSessionHistory } from '@pi-meme/pi-runtime/session-history'
import { inferAgentConversationOrigin, readAgentConversation } from '@pi-meme/pi-runtime/agent-conversation'
import { safeBranchLeaf } from '@pi-meme/pi-runtime/safe-session-fork'

const activeStatuses = new Set(['starting', 'running', 'waiting_children', 'waiting_input'])
type RootBinding = {
  sessionKey: string
  cwd: string
  sessionFile?: string
  sessionId?: string
  state: PiState
  accessMode: AgentAccessMode
  session: RuntimeSdkSession
}
type RunPolicy = Pick<AgentSummary, 'mode' | 'accessMode' | 'model' | 'thinkingLevel'>
type Record = {
  summary: AgentSummary
  session?: RuntimeSdkSession
  mailbox: AgentMailboxMessage[]
  consumed: string[]
  queued: Array<{ message: string; rootTaskId: string; epoch: number; policy: RunPolicy; runId: string }>
  interactions: PendingInteraction[]
  sequence: number
  events?: DesktopEvent[]
  settled?: boolean
  pauseRequested?: boolean
  pauseRevision?: number
  pauseApplied?: boolean
  pendingStart?: { message: string; rootTaskId: string; epoch: number; policy: RunPolicy; runId: string }
  draining?: boolean
  nextMode?: TaskMode
  replies?: Array<{ id: string; result: CollaborationResults[keyof CollaborationResults] }>
}
type Options = {
  dataRoot: string
  assertCheckoutAvailable?: (cwd: string) => void
  createSession: (
    cwd: string,
    notify: ConstructorParameters<typeof import('@pi-meme/pi-runtime/sdk/session').SdkSession>[1],
    sessionKey: string,
    parentSessionKey?: string,
  ) => RuntimeSdkSession
  emit: (event: DesktopEvent) => void
}

export function createHostCollaborationBridge(options: Options) {
  return new HostCollaborationBridge(options)
}
export class HostCollaborationBridge {
  assertCheckoutIdle(matches: (cwd: string) => boolean) {
    if (
      [...this.records.values()].some(
        (record) =>
          matches(record.summary.cwd) &&
          (activeStatuses.has(record.summary.status) || record.queued.length || record.interactions.length),
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
  private answers = new Set<string>()
  private plans: PlanDocument[] = []
  private listeners = new Set<() => void>()
  private userSteering = new WeakSet<Record>()
  private writes: Promise<void> = Promise.resolve()
  private inFlight = new Map<string, Promise<CollaborationResults[keyof CollaborationResults]>>()
  private planWrites: Promise<void> = Promise.resolve()
  private stopping = false
  private ready: Promise<void>
  constructor(private readonly options: Options) {
    this.ready = this.load()
  }
  private async load() {
    const file = path.join(this.options.dataRoot, 'collaboration.json')
    try {
      const saved = JSON.parse(await readFile(file, 'utf8')) as {
        records: Array<Omit<Record, 'session'>>
        plans: PlanDocument[]
      }
      this.plans = saved.plans ?? []
      for (const record of saved.records ?? []) {
        if (activeStatuses.has(record.summary.status)) {
          record.summary.status = 'interrupted'
          record.summary.error = 'Host 已重启，任务未自动恢复'
          record.summary.runCompletedAt = new Date().toISOString()
        }
        record.pauseRequested = false
        record.pauseRevision = 0
        record.summary.isPaused = false
        record.pendingStart = undefined
        record.interactions = []
        record.events = []
        this.records.set(record.summary.agentId, record)
        if (record.summary.depth === 0) this.roots.set(record.summary.rootSessionKey, record)
      }
      await this.persist()
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }
  private persist() {
    const content = JSON.stringify({
      records: [...this.records.values()].map(
        ({
          session: _session,
          pauseRequested: _pause,
          pauseRevision: _revision,
          pauseApplied: _applied,
          pendingStart: _start,
          draining: _draining,
          ...record
        }) => ({ ...record, summary: { ...record.summary, isPaused: undefined } }),
      ),
      plans: this.plans,
    })
    const write = this.writes.then(async () => {
      await mkdir(this.options.dataRoot, { recursive: true })
      const file = path.join(this.options.dataRoot, 'collaboration.json')
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, content, { mode: 0o600 })
        await rename(temporary, file)
      } finally {
        await rm(temporary, { force: true })
      }
    })
    this.writes = write.catch(() => {})
    return write
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
    this.roots.set(binding.sessionKey, record)
    this.callers.set(binding.session, record)
    await this.persist()
    return { ...record.summary }
  }
  async setSessionMode(sessionKey: string, mode: TaskMode) {
    await this.ready
    const root = this.root(sessionKey)
    root.nextMode = mode
    await this.persist()
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
          await this.persist()
          this.changed(record)
          return
        }
        await this.start(record, pending.message, pending.rootTaskId, pending.epoch, pending.policy, pending.runId)
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
    this.userSteering.delete(root)
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
    })
    await this.persist()
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
  async rootFailed(sessionKey: string, cause: unknown, runId?: string) {
    const root = this.root(sessionKey)
    if ((runId && root.summary.runId !== runId) || ['stopped', 'interrupted'].includes(root.summary.status)) return
    root.summary.status = 'failed'
    root.summary.error = String(cause)
    root.summary.runCompletedAt = new Date().toISOString()
    await this.persist()
    this.changed(root)
  }
  async rootSettled(sessionKey: string, event?: { aborted?: boolean; runId?: string }) {
    const root = this.root(sessionKey)
    if (event?.runId && root.summary.runId !== event.runId) return
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
      ) || this.pending(root).some((message) => message.kind === 'result')
        ? 'waiting_children'
        : 'completed'
    root.summary.runCompletedAt = new Date().toISOString()
    await this.persist()
    this.changed(root)
    await this.summarize(root)
  }
  private caller(session: RuntimeSdkSession) {
    const record = this.callers.get(session)
    if (!record || record.session !== session || !activeStatuses.has(record.summary.status))
      throw new Error('协作请求来自无效或已结束任务')
    return record
  }
  private target(caller: Record, target: string) {
    const found = this.tree(caller).find(
      (entry) =>
        entry.summary.agentId === target ||
        entry.summary.taskPath === target ||
        entry.summary.taskPath === `${caller.summary.taskPath}/${target}`,
    )
    if (!found) throw new Error(`子 Agent 不存在：${target}`)
    return found
  }
  private descendant(parent: Record, child: Record) {
    return child.summary.taskPath.startsWith(`${parent.summary.taskPath}/`)
  }
  private capacity(caller: Record, reserved?: Record) {
    if (
      this.tree(caller).filter(
        (entry) =>
          entry !== reserved &&
          entry.summary.depth > 0 &&
          (activeStatuses.has(entry.summary.status) || entry.queued.length > 0),
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
        await this.persist()
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
    if (request.method === 'spawn_agent') {
      this.options.assertCheckoutAvailable?.(caller.summary.cwd)
      const { task_name: name, message, fork_turns: fork = 'all' } = request.params
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || !message.trim()) throw new Error('子 Agent 名称或任务无效')
      if (caller.summary.depth >= collaborationLimits.depth) throw new Error('子 Agent 最多嵌套两层')
      this.capacity(caller)
      if (this.tree(caller).length - 1 >= collaborationLimits.identities) throw new Error('子 Agent 身份最多 16 个')
      const taskPath = `${caller.summary.taskPath}/${name}`
      if (this.tree(caller).some((entry) => entry.summary.taskPath === taskPath))
        throw new Error('任务名称已存在，请用 followup_task 继续已有 Agent')
      const agentId = randomUUID()
      const child: Record = {
        summary: {
          ...caller.summary,
          agentId,
          parentAgentId: caller.summary.agentId,
          name,
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
        await this.start(child, message, admitted.rootTaskId, admitted.epoch, this.policy(caller))
        return { ...child.summary }
      } catch (cause) {
        this.records.delete(agentId)
        await child.session?.stopAndWait()
        await this.persist()
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
      this.options.assertCheckoutAvailable?.(caller.summary.cwd)
      if (!request.params.message.trim()) throw new Error('任务不能为空')
      if (activeStatuses.has(target.summary.status)) {
        target.queued.push({
          message: request.params.message,
          rootTaskId: caller.summary.rootTaskId,
          epoch: caller.summary.epoch,
          policy: this.policy(caller),
          runId: randomUUID(),
        })
        await this.persist()
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
          this.policy(caller),
        )
      } catch (cause) {
        const generation = target.summary.executionGeneration
        if (activeStatuses.has(target.summary.status)) target.summary = { ...previous, executionGeneration: generation }
        await this.persist()
        this.changed(target)
        throw cause
      }
      return { agent: { ...target.summary }, queued: Boolean(target.pendingStart) }
    }
    throw new Error('协作工具无效')
  }
  private policy(record: Record): RunPolicy {
    return {
      mode: record.summary.mode,
      accessMode: record.summary.accessMode,
      model: record.summary.model,
      thinkingLevel: record.summary.thinkingLevel,
    }
  }
  private async start(
    record: Record,
    message: string,
    rootTaskId: string,
    epoch: number,
    policy: RunPolicy,
    scheduledRunId?: string,
  ) {
    if (this.stopping) throw new Error('Host 正在停止')
    this.options.assertCheckoutAvailable?.(record.summary.cwd)
    const replaceWorker =
      record.session && (record.summary.mode !== policy.mode || record.summary.accessMode !== policy.accessMode)
    const runId = scheduledRunId ?? randomUUID()
    const assertStarting = () => {
      if (this.stopping || record.summary.runId !== runId || !['starting', 'running'].includes(record.summary.status))
        throw new Error('子 Agent 启动已取消或轮次更换')
    }
    const task = { message, rootTaskId, epoch, policy, runId }
    this.userSteering.delete(record)
    Object.assign(record.summary, {
      rootTaskId,
      epoch,
      runId,
      status: 'starting',
      task: message,
      report: undefined,
      error: undefined,
      runStartedAt: new Date().toISOString(),
      runCompletedAt: undefined,
    })
    record.summary.isPaused = this.paused(record)
    if (this.paused(record)) {
      record.pendingStart = task
      await this.persist()
      this.changed(record)
      return
    }
    Object.assign(record.summary, policy)
    if (replaceWorker) {
      await record.session!.stopAndWait()
      record.session = undefined
      assertStarting()
    }
    await this.persist()
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
      await this.persist()
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
        this.records.get(record.summary.parentAgentId ?? '')?.summary.sessionKey,
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
      await record.session.configureAgentTask(message, record.summary.conversationOrigin)
      assertStarting()
      record.session.start(record.summary.cwd, record.summary.sessionFile)
      await record.session.snapshot()
      assertStarting()
      if (record.summary.model) await record.session.setModel(record.summary.model)
      if (record.summary.thinkingLevel) await record.session.setThinkingLevel(record.summary.thinkingLevel)
      record.summary.sessionId = record.session.getActiveSession().sessionId
      record.summary.sessionFile = record.session.getActiveSession().sessionFile
      await this.persist()
    }
    await record.session.configureAgentTask(message, record.summary.conversationOrigin)
    if (record.summary.model) await record.session.setModel(record.summary.model)
    if (record.summary.thinkingLevel) await record.session.setThinkingLevel(record.summary.thinkingLevel)
    assertStarting()
    if (this.paused(record)) {
      record.pendingStart = task
      await this.persist()
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
    const fresh = ids.filter((id) => known.has(id) && !record.consumed.includes(id))
    if (fresh.length) {
      record.consumed.push(...fresh)
      void this.persist().catch((cause: unknown) => {
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
      void this.persist().catch((cause: unknown) => {
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
    const snapshot = await record.session!.snapshot().catch((cause: unknown) => {
      record.summary.error = String(cause)
      return { messages: [] }
    })
    if (runId !== record.summary.runId || !activeStatuses.has(record.summary.status)) return
    record.settled = true
    record.summary.sessionFile = record.session!.getActiveSession().sessionFile
    record.summary.sessionId = record.session!.getActiveSession().sessionId
    const last = snapshot.messages.filter((message) => message.role === 'assistant').at(-1)
    const report =
      last?.role === 'assistant'
        ? last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
        : ''
    if (
      !aborted &&
      !record.summary.error &&
      (this.tree(record).some(
        (entry) =>
          this.descendant(record, entry) && (activeStatuses.has(entry.summary.status) || entry.queued.length > 0),
      ) ||
        this.pending(record).some((message) => message.kind === 'result'))
    ) {
      record.summary.status = 'waiting_children'
      await this.persist()
      this.changed(record)
      await this.summarize(record)
      return
    }
    Object.assign(record.summary, {
      status: aborted ? 'interrupted' : record.summary.error ? 'failed' : 'completed',
      report,
      runCompletedAt: new Date().toISOString(),
    })
    const parent = this.records.get(record.summary.parentAgentId ?? '')
    if (parent) {
      const id = `result:${record.summary.agentId}:${runId}`
      if (!parent.mailbox.some((message) => message.id === id) && !parent.consumed.includes(id))
        parent.mailbox.push({
          id,
          fromAgentId: record.summary.agentId,
          toAgentId: parent.summary.agentId,
          rootTaskId: record.summary.rootTaskId,
          epoch: record.summary.epoch,
          runId,
          kind: 'result',
          name: record.summary.name,
          status: record.summary.status,
          completedAt: record.summary.runCompletedAt,
          text: [record.summary.error, report].filter(Boolean).join('\n\n') || '子 Agent 已结束，未返回正文',
          createdAt: new Date().toISOString(),
        })
    }
    await this.persist()
    this.changed(record)
    if (parent) {
      try {
        await this.deliver(parent)
        await this.summarize(parent)
      } catch (cause) {
        parent.summary.error = String(cause)
        this.changed(parent)
      }
    }
    await this.startQueued(record)
  }
  private async startQueued(record: Record) {
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
        await this.start(record, next.message, next.rootTaskId, next.epoch, next.policy, next.runId)
        return
      }
      discarded = true
      next = record.queued.shift()
    }
    if (discarded) {
      await this.persist()
      this.changed(record)
    }
  }

  private async send(caller: Record, target: Record, text: string) {
    if (!text.trim()) throw new Error('消息不能为空')
    const message: AgentMailboxMessage = {
      id: randomUUID(),
      fromAgentId: caller.summary.agentId,
      toAgentId: target.summary.agentId,
      rootTaskId: caller.summary.rootTaskId,
      epoch: caller.summary.epoch,
      runId: caller.summary.runId,
      kind: 'message',
      text,
      createdAt: new Date().toISOString(),
    }
    target.mailbox.push(message)
    await this.persist()
    const delivered = await this.deliver(target)
    this.emit(target, { type: 'agent_mailbox', message })
    this.changed(target)
    return { messageId: message.id, delivered }
  }
  private pending(record: Record) {
    return record.mailbox.filter(
      (message) =>
        (message.kind === 'message' ||
          (message.rootTaskId === record.summary.rootTaskId && message.epoch === record.summary.epoch)) &&
        !record.consumed.includes(message.id),
    )
  }
  private async deliver(record: Record) {
    if (this.paused(record) || record.summary.status !== 'running' || !record.session) return false
    const pending = this.pending(record)
    if (!pending.length) return false
    const persisted: string[] = []
    for (const message of pending) {
      if (this.paused(record)) return false
      const ack = await record.session.deliverCollaborationMessage(message)
      if (ack?.persisted) persisted.push(message.id)
    }
    const fresh = persisted.filter((id) => !record.consumed.includes(id))
    if (fresh.length) {
      record.consumed.push(...fresh)
      await this.persist()
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
    const pending = this.pending(record).filter((message) => message.kind === 'result')
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
    const runId = (record.summary.runId = randomUUID())
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
    await this.persist()
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
      await this.persist()
      if (!isCurrent()) return
      await record.session.continueCollaborationTask(
        '子 Agent 已返回结果，请结合已保存的协作消息检查并继续当前任务。',
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
        await this.persist()
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
    const selected = targets?.map((target) => this.target(record, target))
    if (selected?.some((target) => target === record || this.descendant(target, record)))
      throw new Error('不能等待自己或祖先 Agent')
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 3600000)
      throw new Error('等待时长必须在 0 到 3600000 毫秒之间')
    const watched = selected ?? this.tree(record).filter((entry) => this.descendant(record, entry))
    const runs = new Map(
      watched.map((target) => [target.summary.agentId, target.queued.at(-1)?.runId ?? target.summary.runId]),
    )
    const matches = () =>
      this.pending(record).filter((message) =>
        watched.some(
          (target) =>
            target.summary.agentId === message.fromAgentId &&
            (message.kind === 'message' || message.runId === runs.get(target.summary.agentId)),
        ),
      )
    const available = () =>
      this.userSteering.has(record) ||
      matches().length > 0 ||
      watched.some(
        (target) =>
          (target.summary.runId === runs.get(target.summary.agentId) && !activeStatuses.has(target.summary.status)) ||
          (['stopped', 'interrupted'].includes(target.summary.status) &&
            !target.queued.some((task) => task.runId === runs.get(target.summary.agentId))),
      )
    let timedOut = false
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
      const messages = matches()
      await this.persist()
      return { agents: (selected ?? this.tree(record)).map((entry) => ({ ...entry.summary })), messages, timedOut }
    } finally {
      if (record.summary.status === 'waiting_children') record.summary.status = previous
      this.changed(record)
    }
  }
  private async interrupt(record: Record) {
    const descendants = this.tree(record)
      .filter((entry) => this.descendant(record, entry))
      .reverse()
    for (const child of [...descendants, record]) {
      this.userSteering.delete(child)
      child.queued = []
      child.pendingStart = undefined
      child.summary.isPaused = false
      const wasPaused = child.pauseApplied
      child.pauseApplied = false
      if (!activeStatuses.has(child.summary.status)) {
        if (wasPaused) await child.session?.abort().catch(() => {})
        continue
      }
      child.summary.status = 'interrupted'
      child.summary.runCompletedAt = new Date().toISOString()
      await child.session?.abort().catch(() => {})
      child.interactions = []
      this.changed(child)
    }
    await this.persist()
  }
  async stopRoot(sessionKey: string) {
    await this.ready
    const root = this.root(sessionKey)
    root.pauseRequested = true
    root.pauseRevision = (root.pauseRevision ?? 0) + 1
    await this.interrupt(root)
    root.pauseRequested = false
    root.summary.status = 'stopped'
    await this.persist()
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
    return {
      agent: { ...root.summary },
      agents: tree.map((entry) => ({ ...entry.summary })),
      planDocuments: this.plans.filter((plan) => plan.sessionId === root.summary.sessionId),
      pendingInteractions: tree.flatMap((entry) => entry.interactions),
      agentMessages: tree.flatMap((entry) => entry.mailbox),
    }
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
        await this.persist()
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
        planDocuments: this.plans.filter((plan) => plan.sessionId === record.summary.sessionId),
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
      planDocuments: this.plans.filter((plan) => plan.sessionId === record.summary.sessionId),
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

  async savePlan(actualSession: RuntimeSdkSession, input: SavePlanInput, signal: AbortSignal): Promise<PlanDocument> {
    const pending = this.planWrites.then(() => this.savePlanOnce(actualSession, input, signal))
    this.planWrites = pending.then(
      () => {},
      () => {},
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
    const existing = this.plans.find((plan) => plan.runId === record.summary.runId && plan.sessionId === sessionId)
    const document: PlanDocument = {
      id: existing?.id ?? randomUUID(),
      sessionId,
      runId: record.summary.runId,
      revision: (existing?.revision ?? 0) + 1,
      title: input.title.trim(),
      markdown: input.markdown,
      updatedAt: new Date().toISOString(),
    }
    const runId = record.summary.runId
    const assertCurrent = () => {
      if (signal.aborted || runId !== record.summary.runId || !activeStatuses.has(record.summary.status))
        throw new Error('计划保存轮次已取消或更换')
    }
    const directory = path.join(this.options.dataRoot, 'plans', sessionId)
    const file = path.join(directory, `${document.id}.md`)
    const temporary = `${file}.${randomUUID()}.tmp`
    let replaced = false
    let metadataChanged = false
    try {
      await mkdir(directory, { recursive: true })
      assertCurrent()
      await writeFile(temporary, document.markdown, { mode: 0o600 })
      assertCurrent()
      await rename(temporary, file)
      replaced = true
      assertCurrent()
      if (existing) this.plans[this.plans.indexOf(existing)] = document
      else this.plans.push(document)
      metadataChanged = true
      record.summary.sessionId = sessionId
      await this.persist()
      assertCurrent()
    } catch (cause) {
      if (metadataChanged) {
        if (existing) this.plans[this.plans.indexOf(document)] = existing
        else this.plans = this.plans.filter((plan) => plan !== document)
      }
      if (replaced) {
        if (existing) {
          await writeFile(temporary, existing.markdown, { mode: 0o600 })
          await rename(temporary, file)
        } else await rm(file, { force: true })
      }
      if (metadataChanged) await this.persist()
      throw cause
    } finally {
      await rm(temporary, { force: true })
    }
    this.emit(record, { type: 'plan_saved', document })
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
  async stopAndWait() {
    this.stopping = true
    await this.ready
    for (const root of this.roots.values()) await this.stopRoot(root.summary.rootSessionKey)
    await Promise.all(
      [...this.records.values()]
        .filter((record) => record.summary.depth > 0)
        .map((record) => record.session?.stopAndWait()),
    )
    await Promise.allSettled([...this.inFlight.values(), this.planWrites])
    await this.writes
  }
}
