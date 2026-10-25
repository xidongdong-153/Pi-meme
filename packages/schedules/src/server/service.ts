import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { HostApi, HostControlEvent, SubmissionReceipt } from '@pi-meme/contracts/app-host'
import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskRef, ScheduleRun } from '@pi-meme/contracts/schedules'
import { isAgentAccessMode } from '@pi-meme/contracts/agent-access'
import { thinkingLevels } from '@pi-meme/contracts/pi'
import { missedOccurrences, nextOccurrence, validateRule } from '../shared/rules'

type StoredTask = Omit<ScheduledTask, 'lastRun' | 'activeRun' | 'latestUnreadRun' | 'unreadCount'>
type State = { version: 1; tasks: StoredTask[]; runs: ScheduleRun[] }
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
  private readonly file: string
  constructor(
    private options: { directory: string; hostId: string; now?: () => number; onError?: (cause: unknown) => void },
  ) {
    this.file = path.join(options.directory, 'schedules.json')
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
      if (this.closing) throw new Error('Host 正在退出，不能修改定时任务')
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
    if (!ref || ref.hostId !== this.options.hostId) throw new Error('目标 Host 身份不匹配')
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
      !Array.isArray(config.agentPlugins) ||
      config.agentPlugins.some((id) => typeof id !== 'string' || !id)
    )
      throw new Error('任务模型、思考强度、权限或插件配置无效')
    if (config.mode !== undefined && config.mode !== 'default') throw new Error('定时任务只支持执行模式')
    if (typeof input.newSessionEachRun !== 'boolean' || !['all', 'failures', 'off'].includes(input.notification))
      throw new Error('会话或通知配置无效')
    if (input.project && (input.project.hostId !== this.options.hostId || typeof input.project.projectId !== 'string'))
      throw new Error('任务项目必须属于当前 Host')
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
        nextRunAt,
      }
      this.state.tasks.push(task)
      return this.view(task)
    }, taskId)
  }
  update(ref: ScheduledTaskRef, input: ScheduledTaskInput) {
    this.validateInput(input)
    return this.change(() => {
      const task = this.task(ref)
      if (JSON.stringify(task.project) !== JSON.stringify(input.project))
        throw new Error('创建后不能更改任务的执行项目')
      const ruleChanged = JSON.stringify(task.rule) !== JSON.stringify(input.rule)
      if (task.newSessionEachRun !== input.newSessionEachRun) task.session = undefined
      Object.assign(task, this.clean(input), { updatedAt: this.timestamp() })
      if (ruleChanged) {
        task.nextRunAt = nextOccurrence(task.rule, this.now())
        if (!task.nextRunAt) throw new Error('请选择未来的执行时间')
        if (task.status === 'completed') task.status = 'active'
      }
      return this.view(task)
    }, ref.taskId)
  }
  pause(ref: ScheduledTaskRef) {
    return this.change(() => {
      const task = this.task(ref)
      task.status = 'paused'
      task.updatedAt = this.timestamp()
      return this.view(task)
    }, ref.taskId)
  }
  resume(ref: ScheduledTaskRef) {
    return this.change(() => {
      const task = this.task(ref)
      if (task.error) throw new Error('请先重新建立任务专属聊天')
      task.nextRunAt = nextOccurrence(task.rule, this.now())
      task.status = task.nextRunAt ? 'active' : 'completed'
      task.updatedAt = this.timestamp()
      return this.view(task)
    }, ref.taskId)
  }
  resetSession(ref: ScheduledTaskRef) {
    return this.change(() => {
      const task = this.task(ref)
      task.session = undefined
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
  private makeRun(task: StoredTask, trigger: ScheduleRun['trigger'], scheduledAt: string): ScheduleRun {
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
    this.track(this.execute(run).finally(() => this.launching.delete(run.runId)))
  }
  private async execute(snapshot: ScheduleRun) {
    const ref = { hostId: this.options.hostId, taskId: snapshot.taskId }
    try {
      const task = await this.get(ref)
      if (this.state.runs.find((run) => run.runId === snapshot.runId)?.stopRequested) {
        await this.finish(snapshot.runId, 'cancelled', '用户停止了本次运行')
        return
      }
      let session = !snapshot.newSessionEachRun ? task.session : undefined
      if (session) {
        let existing
        try {
          existing = await this.api!.sessions.get(session)
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
        await this.api!.sessions.configure(session, snapshot.configuration, {
          idempotencyKey: `schedule:${snapshot.runId}:configure`,
        })
      } else {
        const created = await this.api!.sessions.create(
          {
            project: snapshot.project,
            name: `${task.name} · ${new Date(snapshot.startedAt).toLocaleString('zh-CN', { timeZone: task.rule.timeZone })}`,
            configuration: snapshot.configuration,
          },
          { idempotencyKey: `schedule:${snapshot.runId}:create` },
        )
        session = { hostId: created.hostId, sessionId: created.sessionId }
      }
      const target = session
      const proceed = await this.change(() => {
        const run = this.state.runs.find((item) => item.runId === snapshot.runId)!
        if (!inProgress(run) || run.stopRequested) return false
        run.session = target
        if (!snapshot.newSessionEachRun) this.task(ref).session = target
        return true
      }, ref.taskId)
      if (!proceed) {
        await this.finish(snapshot.runId, 'cancelled', '用户停止了本次运行')
        return
      }
      const receipt = await this.api!.sessions.submit(
        target,
        { delivery: 'start', text: snapshot.prompt, mode: 'default' },
        { idempotencyKey: `schedule:${snapshot.runId}:submit` },
      )
      const stopped = await this.change(() => {
        const run = this.state.runs.find((item) => item.runId === snapshot.runId)!
        run.operationId = receipt.operationId
        if (!inProgress(run)) return true
        run.status = 'running'
        return Boolean(run.stopRequested)
      }, ref.taskId)
      if (stopped) {
        await this.api!.sessions.stop(target, { idempotencyKey: `schedule:${snapshot.runId}:late-stop` })
        await this.finish(snapshot.runId, 'cancelled', '用户停止了本次运行')
      } else await this.observeReceipt(await this.api!.sessions.receipt(receipt.operationId))
    } catch (cause) {
      if (!this.closing) {
        const run = this.state.runs.find((item) => item.runId === snapshot.runId)
        const message = cause instanceof Error ? cause.message : String(cause)
        if (run?.stopRequested && run.operationId && inProgress(run))
          await this.change(() => {
            const current = this.state.runs.find((item) => item.runId === snapshot.runId)!
            current.error = `停止未成功：${message}`
          }, ref.taskId)
        else if (!snapshot.newSessionEachRun && !run?.operationId && message.startsWith('会话正在运行'))
          await this.finish(snapshot.runId, 'skipped', '任务专属聊天正在使用，本次已跳过')
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
  }
  private async observeReceipt(receipt: SubmissionReceipt) {
    const run = this.state.runs.find((item) => item.operationId === receipt.operationId)
    if (!run || !inProgress(run)) return
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
    if (!run || !run.operationId || !run.session) return
    await this.api!.sessions.stop(run.session, { idempotencyKey: `schedule:${run.runId}:stop:${randomUUID()}` })
    await this.finish(run.runId, 'cancelled', '用户停止了本次运行')
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
          run.error = busy ? '上次运行尚未结束，本次已跳过' : 'Host 停止、休眠或调度延迟，已跳过错过的执行'
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
      await this.finish(run.runId, 'interrupted', 'Host 已重启，本次执行已中断，不会自动重发')
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
    await this.tail
    this.closing = true
    await Promise.allSettled([...this.jobs])
  }
  async dispose() {
    await this.beginShutdown()
    await this.save()
  }
}
