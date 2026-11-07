import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AppSession,
  HostApi,
  HostControlEvent,
  MutationOptions,
  SessionRef,
  SubmissionInput,
  SubmissionReceipt,
} from '@pi-meme/contracts/app-host'
import type { AuthorizationScope } from '@pi-meme/contracts/authorization'
import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskRef, ScheduleRun } from '@pi-meme/contracts/schedules'
import type { PiSessionSummary } from '@pi-meme/contracts/sessions'
import { isAgentAccessMode } from '@pi-meme/contracts/agent-access'
import { thinkingLevels } from '@pi-meme/contracts/pi'
import { missedOccurrences, nextOccurrence, validateRule } from '../shared/rules'

type StoredTask = Omit<ScheduledTask, 'lastRun' | 'activeRun' | 'latestUnreadRun' | 'unreadCount'> & {
  authorizationRevision?: string
}
type StoredRun = ScheduleRun & { authorizationRevision?: string; taskRevision?: string; executionRunId?: string }
type ScheduleAuthorization = {
  revision: string
  signal?: AbortSignal
  assertCurrent: () => void | Promise<void>
  complete?: (status: ScheduleRun['status'], error?: string) => Promise<void>
}
type ScheduleAuthorizationHooks = {
  admit: (input: {
    task: ScheduledTask
    run: ScheduleRun
    session?: AppSession
    signal: AbortSignal
    taskRevision: string
  }) => Promise<ScheduleAuthorization>
  /** Synchronous check against the Host-owned authorization lease, never caller-provided permissions. */
  assertMutationCurrent?: (input: {
    method: string
    args: unknown[]
    mutation: MutationOptions
    run: ScheduleRun
    taskRevision: string
    authorizationRevision: string
  }) => void
}
type State = { version: 1; tasks: StoredTask[]; runs: StoredRun[] }
const inProgress = (run: ScheduleRun) => run.status === 'starting' || run.status === 'running'

export class ScheduleService {
  private state: State = { version: 1, tasks: [], runs: [] }
  private tail: Promise<unknown> = Promise.resolve()
  private jobs = new Set<Promise<unknown>>()
  private pendingChanges = 0
  private api?: HostApi
  private publish?: (taskId: string) => Promise<unknown>
  private timer?: ReturnType<typeof setInterval>
  private unsubscribe?: () => void
  private closing = false
  private authorizationHooks?: ScheduleAuthorizationHooks
  private readonly executions = new Map<
    string,
    { controller: AbortController; revision: string; cleanup?: () => void; authorization?: ScheduleAuthorization }
  >()
  private readonly mutationGuards = new WeakMap<
    MutationOptions,
    { method: string; args: string; runId: string; taskRevision: string; authorizationRevision: string }
  >()
  private readonly executionJobs = new Map<string, Promise<unknown>>()
  private readonly file: string
  constructor(
    private options: { directory: string; hostId: string; now?: () => number; onError?: (cause: unknown) => void },
  ) {
    this.file = path.join(options.directory, 'schedules.json')
  }
  setAuthorizationHooks(hooks: ScheduleAuthorizationHooks) {
    this.authorizationHooks = hooks
  }
  /** Host may call inside its serialized submit boundary to reject a late start atomically. */
  assertRunAuthorization(runId: string, taskRevision: string) {
    const run = this.state.runs.find((item) => item.runId === runId)
    const task = run && this.state.tasks.find((item) => item.taskId === run.taskId)
    if (
      !run ||
      !task ||
      this.closing ||
      !inProgress(run) ||
      run.stopRequested ||
      this.executions.get(runId)?.controller.signal.aborted ||
      (task.authorizationRevision ?? task.updatedAt) !== taskRevision
    )
      throw new Error('定时任务运行授权已失效')
  }
  /** Invoked by AppControl's synchronous commit hook. A JSON caller cannot mint this WeakMap identity. */
  assertMutationCurrent(method: string, args: unknown[], mutation: MutationOptions) {
    const expected = mutation.expected?.schedule
    if (!expected) return
    const guard = this.mutationGuards.get(mutation)
    if (
      !guard ||
      guard.method !== method ||
      guard.args !== JSON.stringify(args) ||
      guard.runId !== expected.runId ||
      guard.taskRevision !== expected.taskRevision ||
      guard.authorizationRevision !== expected.authorizationRevision
    )
      throw new Error('定时操作缺少 Host 注册的提交守卫')
    const run = this.state.runs.find((item) => item.runId === guard.runId)
    if (!run || run.taskId !== expected.taskId) throw new Error('定时操作目标已变化')
    if (method === 'sessions.submit') {
      this.assertRunAuthorization(guard.runId, guard.taskRevision)
      const authorization = this.executions.get(guard.runId)?.authorization
      if (!authorization || authorization.signal?.aborted || authorization.revision !== guard.authorizationRevision)
        throw new Error('定时任务执行授权已撤销')
    }
    this.authorizationHooks?.assertMutationCurrent?.({
      method,
      args,
      mutation,
      run,
      taskRevision: guard.taskRevision,
      authorizationRevision: guard.authorizationRevision,
    })
  }

  private guardedMutation(method: string, args: unknown[], run: StoredRun, mutation: MutationOptions): MutationOptions {
    const task = this.state.tasks.find((item) => item.taskId === run.taskId)
    const expected = {
      taskId: run.taskId,
      runId: run.runId,
      taskRevision: run.taskRevision ?? task?.authorizationRevision ?? task?.updatedAt ?? 'legacy',
      authorizationRevision: run.authorizationRevision ?? 'legacy',
    }
    mutation.expected = { ...mutation.expected, schedule: expected }
    this.mutationGuards.set(mutation, {
      method,
      args: JSON.stringify(args),
      runId: run.runId,
      taskRevision: expected.taskRevision,
      authorizationRevision: expected.authorizationRevision,
    })
    return mutation
  }

  private async stopOwnedOperation(run: StoredRun, idempotencyKey: string) {
    if (!run.session || !run.operationId) throw new Error('定时提交结果未知，不能停止可能属于其他任务的会话运行')
    const mutation = this.guardedMutation('sessions.stop', [run.session], run, {
      idempotencyKey,
      expected: { operationId: run.operationId, ...(run.executionRunId ? { runId: run.executionRunId } : {}) },
    })
    await this.api!.sessions.stop(run.session, mutation)
  }

  private now() {
    return this.options.now?.() ?? Date.now()
  }
  private timestamp() {
    return new Date(this.now()).toISOString()
  }
  async init() {
    await mkdir(this.options.directory, { recursive: true })
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
      throw cause
    }
    const value = JSON.parse(raw) as State
    if (value.version !== 1 || !Array.isArray(value.tasks) || !Array.isArray(value.runs))
      throw new Error('定时任务数据格式无效')
    for (const task of value.tasks) {
      this.validateInput(task)
      if (
        task.hostId !== this.options.hostId ||
        typeof task.taskId !== 'string' ||
        !['active', 'paused', 'completed'].includes(task.status)
      )
        throw new Error('定时任务身份或状态无效')
    }
    for (const run of value.runs) {
      if (
        !run ||
        typeof run.runId !== 'string' ||
        typeof run.taskId !== 'string' ||
        !['starting', 'running', 'completed', 'failed', 'interrupted', 'cancelled', 'skipped'].includes(run.status)
      )
        throw new Error('任务运行记录无效')
    }
    this.state = value
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const job = this.tail.then(work)
    this.tail = job.catch(() => {})
    return job
  }
  private async save() {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600, flush: true })
      await rename(temporary, this.file)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  private change<T>(work: () => T | Promise<T>, taskId?: string): Promise<T> {
    this.pendingChanges++
    return this.serial(async () => {
      if (this.closing) throw new Error('服务正在退出，不能修改定时任务')
      const before = structuredClone(this.state)
      let result: T
      try {
        result = await work()
        await this.save()
      } catch (cause) {
        this.state = before
        throw cause
      }
      if (taskId) await this.publish?.(taskId).catch((cause) => this.options.onError?.(cause))
      return structuredClone(result)
    }).finally(() => {
      this.pendingChanges--
    })
  }
  private task(ref: ScheduledTaskRef): StoredTask {
    if (!ref || ref.hostId !== this.options.hostId) throw new Error('目标服务身份不匹配')
    const task = this.state.tasks.find((item) => item.taskId === ref.taskId)
    if (!task) throw new Error('定时任务不存在')
    return task
  }
  private view(task: StoredTask): ScheduledTask {
    const runs = this.state.runs.filter((run) => run.taskId === task.taskId)
    return structuredClone({
      ...task,
      lastRun: runs.at(-1),
      activeRun: runs.find(inProgress),
      latestUnreadRun: runs.filter((run) => run.unread).at(-1),
      unreadCount: runs.filter((run) => run.unread).length,
    })
  }
  private validateInput(input: ScheduledTaskInput) {
    if (
      !input ||
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 200 ||
      typeof input.prompt !== 'string' ||
      !input.prompt.trim()
    )
      throw new Error('请填写任务名称和执行说明，名称不能超过 200 字')
    validateRule(input.rule)
    const config = input.configuration
    if (
      !config?.model ||
      typeof config.model.provider !== 'string' ||
      !config.model.provider.trim() ||
      typeof config.model.id !== 'string' ||
      !config.model.id.trim() ||
      !thinkingLevels.includes(config.thinkingLevel) ||
      !isAgentAccessMode(config.accessMode) ||
      (config.mode !== undefined && config.mode !== 'default' && config.mode !== 'plan') ||
      !Array.isArray(config.agentPlugins) ||
      config.agentPlugins.some((id) => typeof id !== 'string' || !id)
    )
      throw new Error('任务模型、思考强度、权限或插件配置无效')
    if (config.mode !== undefined && config.mode !== 'default') throw new Error('定时任务只支持执行模式')
    if (typeof input.newSessionEachRun !== 'boolean' || !['all', 'failures', 'off'].includes(input.notification))
      throw new Error('会话或通知配置无效')
    if (input.project && (input.project.hostId !== this.options.hostId || typeof input.project.projectId !== 'string'))
      throw new Error('任务项目必须属于当前服务')
  }
  private clean(input: ScheduledTaskInput): ScheduledTaskInput {
    return structuredClone({
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      project: input.project,
      rule: input.rule,
      newSessionEachRun: input.newSessionEachRun,
      configuration: input.configuration,
      notification: input.notification,
    })
  }
  list() {
    return this.serial(async () => this.state.tasks.map((task) => this.view(task)))
  }
  sessionTasks() {
    return this.serial(async () => {
      const tasks = new Map(
        this.state.tasks.map((task) => [
          task.taskId,
          {
            taskId: task.taskId,
            name: task.name,
            status: task.status,
            nextRunAt: task.nextRunAt,
            timeZone: task.rule.timeZone,
          },
        ]),
      )
      const sessions = new Map<string, NonNullable<PiSessionSummary['scheduledTask']>>()
      for (const task of this.state.tasks) {
        if (task.session) sessions.set(task.session.sessionId, tasks.get(task.taskId)!)
      }
      for (const run of this.state.runs) {
        const task = tasks.get(run.taskId)
        if (run.session && task) sessions.set(run.session.sessionId, task)
      }
      return sessions
    })
  }
  get(ref: ScheduledTaskRef) {
    return this.serial(async () => this.view(this.task(ref)))
  }
  async create(input: ScheduledTaskInput) {
    this.validateInput(input)
    if (input.project) await this.api?.projects.get(input.project)
    const taskId = randomUUID()
    return this.change(() => {
      const nextRunAt = nextOccurrence(input.rule, this.now())
      if (!nextRunAt) throw new Error('请选择未来的执行时间')
      const task: StoredTask = {
        ...this.clean(input),
        hostId: this.options.hostId,
        taskId,
        createdAt: this.timestamp(),
        updatedAt: this.timestamp(),
        status: 'active',
        authorizationRevision: randomUUID(),
        nextRunAt,
      }
      this.state.tasks.push(task)
      return this.view(task)
    }, taskId)
  }
  async update(ref: ScheduledTaskRef, input: ScheduledTaskInput) {
    this.validateInput(input)
    let authorizationChanged = false
    await this.change(() => {
      const task = this.task(ref)
      if (JSON.stringify(task.project) !== JSON.stringify(input.project))
        throw new Error('创建后不能更改任务的执行项目')
      const ruleChanged = JSON.stringify(task.rule) !== JSON.stringify(input.rule)
      authorizationChanged =
        JSON.stringify([task.configuration.accessMode, task.configuration.mode, task.configuration.agentPlugins]) !==
        JSON.stringify([input.configuration.accessMode, input.configuration.mode, input.configuration.agentPlugins])
      if (task.newSessionEachRun !== input.newSessionEachRun) task.session = undefined
      Object.assign(task, this.clean(input), { updatedAt: this.timestamp(), authorizationRevision: randomUUID() })
      if (ruleChanged) {
        task.nextRunAt = nextOccurrence(task.rule, this.now())
        if (!task.nextRunAt) throw new Error('请选择未来的执行时间')
        if (task.status === 'completed') task.status = 'active'
      }
      return this.view(task)
    }, ref.taskId)
    if (authorizationChanged) await this.stopRun(ref)
    return this.get(ref)
  }
  async pause(ref: ScheduledTaskRef) {
    await this.change(() => {
      const task = this.task(ref)
      task.status = 'paused'
      task.updatedAt = this.timestamp()
      task.authorizationRevision = randomUUID()
      for (const run of this.state.runs) if (run.taskId === task.taskId && inProgress(run)) run.stopRequested = true
      return this.view(task)
    }, ref.taskId)
    for (const run of this.state.runs)
      if (run.taskId === ref.taskId) this.executions.get(run.runId)?.controller.abort(new Error('定时任务已暂停'))
    await this.stopRun(ref)
    return this.get(ref)
  }
  resume(ref: ScheduledTaskRef) {
    return this.change(() => {
      const task = this.task(ref)
      if (task.error) throw new Error('请先重新建立任务专属聊天')
      task.nextRunAt = nextOccurrence(task.rule, this.now())
      task.status = task.nextRunAt ? 'active' : 'completed'
      task.updatedAt = this.timestamp()
      task.authorizationRevision = randomUUID()
      return this.view(task)
    }, ref.taskId)
  }
  resetSession(ref: ScheduledTaskRef) {
    return this.change(() => {
      const task = this.task(ref)
      if (this.state.runs.some((run) => run.taskId === ref.taskId && inProgress(run)))
        throw new Error('请先停止本次运行，再重建任务会话')
      task.session = undefined
      task.authorizationRevision = randomUUID()
      task.error = undefined
      return this.view(task)
    }, ref.taskId)
  }
  delete(ref: ScheduledTaskRef) {
    return this.change(() => {
      this.task(ref)
      if (this.state.runs.some((run) => run.taskId === ref.taskId && inProgress(run)))
        throw new Error('请先停止本次运行，再删除任务')
      this.state.tasks = this.state.tasks.filter((task) => task.taskId !== ref.taskId)
      this.state.runs = this.state.runs.filter((run) => run.taskId !== ref.taskId)
    }, ref.taskId)
  }
  runs(ref: ScheduledTaskRef, input: { offset?: number; limit?: number } = {}) {
    return this.serial(async () => {
      this.task(ref)
      const { offset = 0, limit = 50 } = input
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
        throw new Error('运行记录分页参数无效')
      return structuredClone(
        this.state.runs
          .filter((run) => run.taskId === ref.taskId)
          .reverse()
          .slice(offset, offset + limit),
      )
    })
  }
  markRead(ref: ScheduledTaskRef, runId: string) {
    return this.change(() => {
      this.task(ref)
      const run = this.state.runs.find((item) => item.taskId === ref.taskId && item.runId === runId)
      if (!run) throw new Error('运行记录不存在')
      run.unread = false
    }, ref.taskId)
  }
  private makeRun(task: StoredTask, trigger: ScheduleRun['trigger'], scheduledAt: string): StoredRun {
    return {
      runId: randomUUID(),
      taskId: task.taskId,
      trigger,
      scheduledAt,
      startedAt: this.timestamp(),
      status: 'starting',
      prompt: task.prompt,
      project: task.project,
      newSessionEachRun: task.newSessionEachRun,
      configuration: structuredClone(task.configuration),
      taskRevision: task.authorizationRevision,
      unread: false,
    }
  }
  private track(job: Promise<unknown>) {
    this.jobs.add(job)
    void job.catch((cause) => this.options.onError?.(cause)).finally(() => this.jobs.delete(job))
  }
  async runNow(ref: ScheduledTaskRef) {
    if (!this.api) throw new Error('定时任务调度尚未就绪')
    const run = await this.change(() => {
      const task = this.task(ref)
      const current = this.state.runs.find((item) => item.taskId === task.taskId && inProgress(item))
      if (current) return current
      const run = this.makeRun(task, 'manual', this.timestamp())
      this.state.runs.push(run)
      return run
    }, ref.taskId)
    this.launch(run)
    return run
  }
  private launching = new Set<string>()
  private launch(run: ScheduleRun) {
    if (this.launching.has(run.runId) || run.status !== 'starting') return
    this.launching.add(run.runId)
    const job = this.execute(run).finally(() => {
      this.launching.delete(run.runId)
      this.executionJobs.delete(run.runId)
    })
    this.executionJobs.set(run.runId, job)
    this.track(job)
  }
  private async execute(snapshot: StoredRun) {
    const ref = { hostId: this.options.hostId, taskId: snapshot.taskId }
    const controller = new AbortController()
    let authorization: ScheduleAuthorization | undefined
    let target: SessionRef | undefined
    let submitted = false
    let submissionAttempted = false
    try {
      const task = await this.get(ref)
      const revision = snapshot.taskRevision ?? this.task(ref).authorizationRevision ?? task.updatedAt
      this.executions.set(snapshot.runId, { controller, revision })
      const assertLocal = () => {
        const current = this.state.runs.find((run) => run.runId === snapshot.runId)
        const owner = this.task(ref)
        if (
          this.closing ||
          controller.signal.aborted ||
          !current ||
          !inProgress(current) ||
          current.stopRequested ||
          (owner.authorizationRevision ?? owner.updatedAt) !== revision
        )
          throw new Error('定时任务启动授权已取消或版本已变化')
      }
      const assertActive = async () => {
        assertLocal()
        await authorization?.assertCurrent()
        assertLocal()
        if (authorization?.signal?.aborted || controller.signal.aborted) throw new Error('定时任务运行授权已撤销')
      }
      await assertActive()
      target = !snapshot.newSessionEachRun ? task.session : undefined
      let existing: AppSession | undefined
      if (target) {
        try {
          existing = await this.api!.sessions.get(target)
        } catch (cause) {
          if (!(cause instanceof Error) || cause.message !== '会话不存在') throw cause
          await this.change(() => {
            const item = this.task(ref)
            item.status = 'paused'
            item.error = '任务专属聊天已删除，请重新建立聊天后恢复任务'
          }, ref.taskId)
          throw new Error('任务专属聊天已删除，请重新建立聊天后恢复任务')
        }
        if (existing.status === 'running') {
          await this.finish(snapshot.runId, 'skipped', '任务专属聊天正在使用，本次已跳过')
          return
        }
        const rank = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 }
        const currentAccess = existing.configuration.accessMode
        if (!currentAccess || rank[currentAccess] > rank[snapshot.configuration.accessMode])
          throw new Error('当前会话高于定时任务的权限上限，请先手动收紧会话权限后重新运行')
        if ((existing.configuration.agentPlugins ?? []).some((id) => !snapshot.configuration.agentPlugins.includes(id)))
          throw new Error('当前会话包含任务未授权的 Agent 插件，请先移除后重新运行')
      }
      if (!this.authorizationHooks) throw new Error('定时执行缺少当前授权准入器，任务未提交')
      authorization = await this.authorizationHooks.admit({
        task,
        run: snapshot,
        session: existing,
        signal: controller.signal,
        taskRevision: revision,
      })
      if (!authorization.revision || !authorization.assertCurrent) throw new Error('定时任务授权版本无效')
      this.executions.get(snapshot.runId)!.authorization = authorization
      const abort = () => {
        controller.abort(new Error('定时任务授权已撤销'))
        void this.stopRun(ref).catch((cause) => this.options.onError?.(cause))
      }
      authorization.signal?.addEventListener('abort', abort, { once: true })
      this.executions.get(snapshot.runId)!.cleanup = () => authorization?.signal?.removeEventListener('abort', abort)
      if (authorization.signal?.aborted) abort()
      await assertActive()
      await this.change(() => {
        const run = this.state.runs.find((item) => item.runId === snapshot.runId)!
        run.authorizationRevision = authorization!.revision
        if (existing)
          run.configuration = {
            ...snapshot.configuration,
            accessMode: existing.configuration.accessMode!,
            agentPlugins: existing.configuration.agentPlugins ?? [],
            mode: snapshot.configuration.mode === 'plan' || existing.configuration.mode === 'plan' ? 'plan' : undefined,
          }
      }, ref.taskId)
      await assertActive()
      if (!target) {
        const created = await this.api!.sessions.create(
          {
            project: snapshot.project,
            name: `${task.name} · ${new Date(snapshot.startedAt).toLocaleString('zh-CN', { timeZone: task.rule.timeZone })}`,
            configuration: snapshot.configuration,
          },
          { idempotencyKey: `schedule:${snapshot.runId}:create` },
        )
        target = { hostId: created.hostId, sessionId: created.sessionId }
        existing = created
      }
      // Never restore saved access/mode/plugins onto an existing, possibly tightened session.
      const activeTarget = target
      const proceed = await this.change(() => {
        const run = this.state.runs.find((item) => item.runId === snapshot.runId)!
        run.session = activeTarget
        if (!snapshot.newSessionEachRun) this.task(ref).session = activeTarget
        return inProgress(run) && !run.stopRequested
      }, ref.taskId)
      if (!proceed) throw new Error('定时任务启动已取消')
      await assertActive()
      submissionAttempted = true
      const submission: SubmissionInput = {
        delivery: 'start',
        text: snapshot.prompt,
        // Explicit Plan can only narrow; omitted default preserves a concurrent Plan selection.
        ...(snapshot.configuration.mode === 'plan' || existing?.configuration.mode === 'plan'
          ? { mode: 'plan' as const }
          : {}),
        model: snapshot.configuration.model,
        thinkingLevel: snapshot.configuration.thinkingLevel,
      }
      const ownedRun = this.state.runs.find((item) => item.runId === snapshot.runId)!
      const mutation = this.guardedMutation('sessions.submit', [activeTarget, submission], ownedRun, {
        idempotencyKey: `schedule:${snapshot.runId}:submit`,
        expected: {
          policy: {
            accessMode: existing!.configuration.accessMode!,
            mode: existing!.configuration.mode ?? 'default',
            agentPlugins: existing!.configuration.agentPlugins ?? [],
          },
        },
      })
      const receipt = await this.api!.sessions.submit(activeTarget, submission, mutation)
      submitted = true
      const stopped = await this.change(() => {
        const run = this.state.runs.find((item) => item.runId === snapshot.runId)!
        run.operationId = receipt.operationId
        run.executionRunId = receipt.runId
        if (!inProgress(run)) return true
        run.status = 'running'
        return Boolean(run.stopRequested || controller.signal.aborted || authorization!.signal?.aborted)
      }, ref.taskId)
      if (stopped) {
        await this.stopOwnedOperation(
          this.state.runs.find((run) => run.runId === snapshot.runId)!,
          `schedule:${snapshot.runId}:late-stop`,
        )
        await this.finish(snapshot.runId, 'cancelled', '定时任务授权已取消')
      } else await this.observeReceipt(await this.api!.sessions.receipt(receipt.operationId))
    } catch (cause) {
      if (!this.closing) {
        const run = this.state.runs.find((item) => item.runId === snapshot.runId)
        const message = cause instanceof Error ? cause.message : String(cause)
        if (
          (submitted || run?.operationId) &&
          target &&
          (controller.signal.aborted || run?.stopRequested || authorization?.signal?.aborted)
        ) {
          try {
            await this.stopOwnedOperation(run!, `schedule:${snapshot.runId}:failed-start-stop`)
          } catch (stopCause) {
            await this.change(() => {
              const current = this.state.runs.find((item) => item.runId === snapshot.runId)!
              current.error = `停止未确认：${String(stopCause)}`
            }, ref.taskId)
            throw stopCause
          }
        }
        if (run?.stopRequested || controller.signal.aborted || authorization?.signal?.aborted)
          await this.finish(snapshot.runId, 'cancelled', message)
        else if (!snapshot.newSessionEachRun && !run?.operationId && message.startsWith('会话正在运行'))
          await this.finish(snapshot.runId, 'skipped', '任务专属聊天正在使用，本次已跳过')
        else if (submissionAttempted && !run?.operationId)
          await this.finish(snapshot.runId, 'interrupted', `提交结果未确认；不会自动重发：${message}`)
        else await this.finish(snapshot.runId, 'failed', message)
      }
    }
  }
  private async finish(runId: string, status: ScheduleRun['status'], error?: string) {
    const taskId = this.state.runs.find((run) => run.runId === runId)?.taskId
    await this.change(() => {
      const run = this.state.runs.find((item) => item.runId === runId)
      if (!run || !inProgress(run)) return
      run.status = status
      run.error = error
      run.finishedAt = this.timestamp()
      run.needsInput = false
      const task = this.state.tasks.find((item) => item.taskId === run.taskId)
      if (task?.rule.kind === 'once' && !task.nextRunAt && task.status === 'active') task.status = 'completed'
      run.unread = Boolean(
        task &&
        status !== 'skipped' &&
        task.notification !== 'off' &&
        (task.notification === 'all' || ['failed', 'interrupted'].includes(status)),
      )
    }, taskId)
    const execution = this.executions.get(runId)
    execution?.cleanup?.()
    this.executions.delete(runId)
    await execution?.authorization?.complete?.(status, error)
  }
  private async observeReceipt(receipt: SubmissionReceipt) {
    const run = this.state.runs.find((item) => item.operationId === receipt.operationId)
    if (!run || !inProgress(run)) return
    if (receipt.runId && run.executionRunId !== receipt.runId)
      await this.change(() => {
        const current = this.state.runs.find((item) => item.runId === run.runId)
        if (current && current.operationId === receipt.operationId) current.executionRunId = receipt.runId
      }, run.taskId)
    if (['completed', 'failed', 'interrupted', 'cancelled'].includes(receipt.status))
      await this.finish(run.runId, receipt.status as ScheduleRun['status'], receipt.error)
  }
  async stopRun(ref: ScheduledTaskRef) {
    const run = await this.change(() => {
      this.task(ref)
      const current = this.state.runs.find((item) => item.taskId === ref.taskId && inProgress(item))
      if (current) current.stopRequested = true
      return current
    }, ref.taskId)
    if (!run) return
    this.executions.get(run.runId)?.controller.abort(new Error('定时任务运行已停止'))
    if (run.operationId && run.session) {
      await this.stopOwnedOperation(run, `schedule:${run.runId}:stop:${randomUUID()}`)
      await this.finish(run.runId, 'cancelled', '用户停止了本次运行')
    }
    const job = this.executionJobs.get(run.runId)
    if (job) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          job,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('定时任务启动取消尚未确认')), 10000)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    const latest = this.state.runs.find((item) => item.runId === run.runId)
    if (latest && inProgress(latest) && !latest.operationId)
      await this.finish(latest.runId, 'cancelled', '用户停止了本次运行')
  }
  /** Pauses matched tasks and drains their starts/runs; reopening authorization never resumes them. */
  async revokeAuthorization(scope: AuthorizationScope) {
    if (scope.hostId !== this.options.hostId) throw new Error('撤权目标服务不匹配')
    const ids = await this.change(() => {
      const matches = (task: StoredTask) =>
        (!scope.projectId || task.project?.projectId === scope.projectId) &&
        (!scope.sessionId ||
          task.session?.sessionId === scope.sessionId ||
          this.state.runs.some(
            (run) =>
              run.taskId === task.taskId &&
              (run.session?.sessionId === scope.sessionId || (inProgress(run) && !run.session)),
          ))
      const tasks = this.state.tasks.filter(matches)
      for (const task of tasks) {
        task.status = 'paused'
        task.authorizationRevision = randomUUID()
        task.updatedAt = this.timestamp()
        for (const run of this.state.runs) if (run.taskId === task.taskId && inProgress(run)) run.stopRequested = true
      }
      return tasks.map((task) => task.taskId)
    })
    for (const taskId of ids)
      for (const run of this.state.runs)
        if (run.taskId === taskId) this.executions.get(run.runId)?.controller.abort(new Error('定时任务授权已撤销'))
    const results = await Promise.allSettled(ids.map((taskId) => this.stopRun({ hostId: this.options.hostId, taskId })))
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    for (const taskId of ids) await this.publish?.(taskId)
  }

  async tick(startup = false) {
    if (this.closing) return
    const launched = await this.change(() => {
      const pending: ScheduleRun[] = []
      const changed: string[] = []
      const now = this.now()
      for (const task of this.state.tasks) {
        if (task.status !== 'active' || !task.nextRunAt || Date.parse(task.nextRunAt) > now) continue
        changed.push(task.taskId)
        const run = this.makeRun(task, 'scheduled', task.nextRunAt)
        const missed = startup || now - Date.parse(task.nextRunAt) > 30000
        const busy = this.state.runs.some((item) => item.taskId === task.taskId && inProgress(item))
        if (missed || busy) {
          const advance = missedOccurrences(task.rule, task.nextRunAt, now)
          run.status = 'skipped'
          run.finishedAt = this.timestamp()
          run.missedCount = advance.count
          run.error = busy ? '上次运行尚未结束，本次已跳过' : '服务停止、休眠或调度延迟，已跳过错过的执行'
          task.nextRunAt = advance.next
        } else {
          task.nextRunAt = nextOccurrence(task.rule, now)
          pending.push(run)
        }
        if (!task.nextRunAt && run.status === 'skipped') task.status = 'completed'
        this.state.runs.push(run)
      }
      return { pending, changed }
    })
    for (const run of launched.pending) this.launch(run)
    for (const taskId of launched.changed) await this.publish?.(taskId)
  }
  async start(api: HostApi, publish: (taskId: string) => Promise<unknown>) {
    this.api = api
    this.publish = publish
    this.unsubscribe = await api.events.subscribe({}, (event: HostControlEvent) => {
      if (this.closing) return
      if (event.type === 'submission') this.track(this.observeReceipt(event.value as SubmissionReceipt))
      if (
        event.type === 'runtime' &&
        event.sessionId &&
        this.state.runs.some((run) => inProgress(run) && run.session?.sessionId === event.sessionId)
      ) {
        const value = event.value as { event?: { type?: string } }
        if (['extension_ui_request', 'extension_ui_closed', 'extension_ui_timeout'].includes(value.event?.type ?? ''))
          this.track(
            this.change(
              () => {
                for (const run of this.state.runs)
                  if (inProgress(run) && run.session?.sessionId === event.sessionId)
                    run.needsInput = value.event?.type === 'extension_ui_request'
              },
              this.state.runs.find((run) => inProgress(run) && run.session?.sessionId === event.sessionId)?.taskId,
            ),
          )
      }
    })
    for (const run of [...this.state.runs].filter(inProgress)) {
      if (run.operationId) {
        try {
          await this.observeReceipt(await api.sessions.receipt(run.operationId))
        } catch {
          /* 缺失回执按中断处理。 */
        }
      }
      await this.finish(run.runId, 'interrupted', '服务已重启，本次执行已中断，不会自动重发')
    }
    await this.tick(true)
    this.timer = setInterval(() => {
      if (
        !this.state.tasks.some(
          (task) => task.status === 'active' && task.nextRunAt && Date.parse(task.nextRunAt) <= this.now(),
        )
      )
        return
      this.track(this.tick())
    }, 1000)
    this.timer.unref?.()
  }
  prepareMaintenance() {
    if (this.pendingChanges || this.jobs.size || this.state.runs.some(inProgress))
      throw new Error('定时任务仍在执行，请先停止后再维护存储')
    this.closing = true
    if (this.timer) clearInterval(this.timer)
    this.unsubscribe?.()
  }
  async beginShutdown() {
    if (this.timer) clearInterval(this.timer)
    this.unsubscribe?.()
    if (this.closing) {
      await Promise.allSettled([...this.jobs])
      return
    }
    await this.tail
    const activeTasks = [...new Set(this.state.runs.filter(inProgress).map((run) => run.taskId))]
    const stopped = await Promise.allSettled(
      activeTasks.map((taskId) => this.stopRun({ hostId: this.options.hostId, taskId })),
    )
    this.closing = true
    const failed = stopped.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    await Promise.allSettled([...this.jobs])
  }
  async dispose() {
    await this.beginShutdown()
    await this.save()
  }
}
