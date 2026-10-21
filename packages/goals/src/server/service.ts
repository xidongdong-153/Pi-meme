import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  goalEntryUsage,
  isGoalUsageEntry,
  goalRunEntry,
  goalTokens,
  validateGoalControl,
  validateGoalInput,
} from '@pi-meme/contracts/goal'
import type { Goal, GoalControl, GoalEdit, GoalInput, GoalRun, GoalStatus, GoalUpdate } from '@pi-meme/contracts/goal'
import { skillMarker } from '@pi-meme/contracts/skills'
import type { SessionRef } from '@pi-meme/contracts/app-host'

type Report = Pick<GoalUpdate, 'progress' | 'blockerKey'>
type Cycle = { id: string; report?: Report; activity: boolean; settled: boolean }
type StoredGoal = { goal: Goal; accounted: string[]; cycle?: Cycle; emptyTurns: number; pendingInput?: GoalInput }
type State = { version: 1; goals: Record<string, StoredGoal> }
export type GoalServiceOptions = {
  file: string
  sessionsDirectory: string
  now?: () => number
  write?: (file: string, data: string) => Promise<void>
}
type Options = GoalServiceOptions

async function atomicWrite(file: string, data: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(file), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

export function isValidGoalState(value: unknown): value is State {
  if (!value || typeof value !== 'object') return false
  const state = value as State
  return (
    state.version === 1 &&
    !!state.goals &&
    typeof state.goals === 'object' &&
    !Array.isArray(state.goals) &&
    Object.entries(state.goals).every(([id, item]) => {
      if (!item?.goal || !Array.isArray(item.accounted) || item.accounted.some((key) => typeof key !== 'string'))
        return false
      const goal = item.goal
      try {
        validateGoalInput(goal)
        if (item.pendingInput) validateGoalInput(item.pendingInput)
      } catch {
        return false
      }
      return (
        goal.session?.sessionId === id &&
        typeof goal.session.hostId === 'string' &&
        typeof goal.goalId === 'string' &&
        Number.isSafeInteger(goal.revision) &&
        goal.revision > 0 &&
        Number.isSafeInteger(goal.tokensUsed) &&
        goal.tokensUsed >= 0 &&
        Number.isSafeInteger(goal.elapsedMs) &&
        goal.elapsedMs >= 0 &&
        Number.isSafeInteger(goal.turns) &&
        goal.turns >= 0 &&
        typeof goal.usageIncomplete === 'boolean' &&
        Array.isArray(goal.evidence) &&
        goal.evidence.every((s) => typeof s === 'string') &&
        ['active', 'paused', 'blocked', 'usage_limited', 'complete'].includes(goal.status) &&
        typeof goal.createdAt === 'string' &&
        typeof goal.updatedAt === 'string' &&
        Number.isFinite(Date.parse(goal.createdAt)) &&
        Number.isFinite(Date.parse(goal.updatedAt)) &&
        (goal.reason === undefined || typeof goal.reason === 'string') &&
        (goal.progress === undefined || typeof goal.progress === 'string') &&
        (goal.inputEntryId === undefined || typeof goal.inputEntryId === 'string') &&
        (!goal.blocker ||
          (typeof goal.blocker.key === 'string' &&
            Number.isSafeInteger(goal.blocker.count) &&
            goal.blocker.count >= 0)) &&
        Number.isSafeInteger(item.emptyTurns) &&
        item.emptyTurns >= 0 &&
        (!item.cycle ||
          (typeof item.cycle.id === 'string' &&
            typeof item.cycle.settled === 'boolean' &&
            typeof item.cycle.activity === 'boolean'))
      )
    })
  )
}

export class GoalService {
  private state: State = { version: 1, goals: {} }
  private pending: Promise<unknown> = Promise.resolve()
  private listeners = new Set<(session: SessionRef, goal: Goal | undefined, goalId: string) => void>()
  private activities = new Set<string>()
  private clocks = new Map<string, { at: number; running: boolean; pendingMs: number }>()
  private storageError?: Error
  private readonly now: () => number
  constructor(private readonly options: Options) {
    if (!options.file) throw new Error('缺少 goals 存储文件路径')
    this.now = options.now ?? Date.now
  }
  async init() {
    try {
      const contents = await readFile(this.options.file, 'utf8')
      const data: unknown = JSON.parse(contents)
      this.removeLegacyBudget(data)
      if (!this.validState(data)) throw new Error('目标存储格式损坏或版本不受支持')
      this.state = data
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`无法读取目标存储：${String(cause)}`)
    }
    await this.reconcile()
    await this.mutate((state) => {
      for (const item of Object.values(state.goals)) {
        if (item.goal.status === 'active') this.transition(item.goal, 'paused', 'Host 已重启，请手动恢复目标')
      }
    })
  }
  private removeLegacyBudget(value: unknown) {
    const state = value as {
      version?: number
      goals?: Record<string, { goal?: Record<string, unknown>; pendingInput?: Record<string, unknown> }>
    } | null
    if (state?.version !== 1 || !state.goals || typeof state.goals !== 'object' || Array.isArray(state.goals)) return
    for (const item of Object.values(state.goals)) {
      if (!item?.goal || typeof item.goal !== 'object') continue
      delete item.goal.tokenBudget
      if (item.pendingInput && typeof item.pendingInput === 'object') delete item.pendingInput.tokenBudget
      if (item.goal.status === 'budget_limited') {
        item.goal.status = 'paused'
        item.goal.reason = '预算功能已移除，请手动恢复目标'
        if (typeof item.goal.revision === 'number') item.goal.revision++
        item.goal.updatedAt = new Date(this.now()).toISOString()
      }
    }
  }
  private validState(value: unknown): value is State {
    return isValidGoalState(value)
  }
  subscribe(listener: (session: SessionRef, goal: Goal | undefined, goalId: string) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  get(session: SessionRef) {
    const stored = this.state.goals[session.sessionId]
    if (!stored || stored.goal.session.hostId !== session.hostId) return undefined
    const goal = structuredClone(stored.goal)
    const clock = this.clocks.get(goal.goalId)
    if (clock) goal.elapsedMs += clock.pendingMs + (clock.running ? Math.max(0, this.now() - clock.at) : 0)
    return goal
  }
  list() {
    return Object.values(this.state.goals).map(({ goal }) => this.get(goal.session)!)
  }
  private async mutate<T>(action: (state: State) => T): Promise<T> {
    const pending = this.pending
      .catch(() => {})
      .then(async () => {
        const state = structuredClone(this.state)
        const result = action(state)
        try {
          await (this.options.write ?? atomicWrite)(this.options.file, `${JSON.stringify(state)}\n`)
        } catch (cause) {
          this.storageError = new Error(`目标保存失败，已停止自动续跑：${String(cause)}`)
          throw this.storageError
        }
        this.storageError = undefined
        const previous = this.state
        this.state = state
        for (const [key, item] of Object.entries(state.goals)) {
          if (JSON.stringify(previous.goals[key]) !== JSON.stringify(item))
            for (const listener of this.listeners)
              listener(item.goal.session, this.get(item.goal.session), item.goal.goalId)
        }
        for (const [key, item] of Object.entries(previous.goals)) {
          if (!state.goals[key])
            for (const listener of this.listeners) listener(item.goal.session, undefined, item.goal.goalId)
        }
        return structuredClone(result)
      })
    this.pending = pending
    return pending
  }
  private item(state: State, session: SessionRef, expected?: GoalControl) {
    const item = state.goals[session.sessionId]
    if (!item || item.goal.session.hostId !== session.hostId) throw new Error('当前会话没有目标')
    if (expected && (expected.goalId !== item.goal.goalId || expected.revision !== item.goal.revision))
      throw new Error('目标已更新，请刷新后重试')
    return item
  }
  private transition(goal: Goal, status: GoalStatus, reason?: string) {
    if (status !== 'active') {
      this.flushClock(goal)
      if (status !== 'complete') this.clocks.delete(goal.goalId)
    }
    goal.status = status
    goal.reason = reason
    goal.updatedAt = new Date(this.now()).toISOString()
    goal.revision++
  }
  start(session: SessionRef, input: GoalInput, inputEntryId?: string) {
    validateGoalInput(input)
    input = {
      objective: input.objective,
      images: input.images,
      skills: input.skills,
      sourceMessageTimestamp: input.sourceMessageTimestamp,
    }
    return this.mutate((state) => {
      if (state.goals[session.sessionId]?.goal.status && state.goals[session.sessionId].goal.status !== 'complete')
        throw new Error('已有未完成目标，请编辑或清除后重试')
      const now = new Date(this.now()).toISOString()
      let skillIndex = 0
      const objective = input.objective.replaceAll(
        skillMarker,
        () => `$${input.skills?.[skillIndex++]?.name ?? '技能'}`,
      )
      const goal: Goal = {
        goalId: randomUUID(),
        session: { hostId: session.hostId, sessionId: session.sessionId },
        revision: 1,
        objective: objective.trim(),
        status: 'active',
        tokensUsed: 0,
        elapsedMs: 0,
        usageIncomplete: false,
        evidence: [],
        turns: 0,
        createdAt: now,
        updatedAt: now,
        inputEntryId,
      }
      state.goals[session.sessionId] = {
        goal,
        accounted: [],
        emptyTurns: 0,
        pendingInput: inputEntryId ? undefined : structuredClone(input),
      }
      return goal
    })
  }
  edit(session: SessionRef, input: GoalEdit) {
    validateGoalControl(input)
    validateGoalInput(input)
    return this.mutate((state) => {
      const item = this.item(state, session, input)
      if (['active', 'complete'].includes(item.goal.status)) throw new Error('请先暂停目标后再编辑')
      item.goal.objective = input.objective.trim()
      if (item.pendingInput) item.pendingInput.objective = input.objective.trim()
      item.goal.blocker = undefined
      item.goal.evidence = []
      item.emptyTurns = 0
      item.cycle = undefined
      this.transition(item.goal, 'paused', '目标已修改，请手动恢复')
      return item.goal
    })
  }
  stop(
    session: SessionRef,
    status: Exclude<GoalStatus, 'active' | 'complete'>,
    reason: string,
    expected?: GoalControl,
  ) {
    if (expected !== undefined) validateGoalControl(expected)
    return this.mutate((state) => {
      const item = this.item(state, session, expected)
      if (expected && item.goal.status === 'complete') throw new Error('目标已完成，请创建新目标或清除目标')
      if (item.goal.status === 'active' || expected) {
        this.flushClock(item.goal)
        this.clocks.delete(item.goal.goalId)
        this.transition(item.goal, status, reason)
      }
      return item.goal
    })
  }
  resume(session: SessionRef, expected: GoalControl) {
    validateGoalControl(expected)
    return this.mutate((state) => {
      const item = this.item(state, session, expected)
      if (item.goal.status === 'complete') throw new Error('目标已完成，请创建新目标')
      if (item.goal.status === 'active') throw new Error('目标正在执行')
      item.goal.blocker = undefined
      item.emptyTurns = 0
      item.cycle = undefined
      this.transition(item.goal, 'active')
      return item.goal
    })
  }
  clear(session: SessionRef, expected: GoalControl) {
    validateGoalControl(expected)
    return this.mutate((state) => {
      const item = this.item(state, session, expected)
      this.clocks.delete(item.goal.goalId)
      delete state.goals[session.sessionId]
    })
  }
  deleteSessions(sessionIds: string[]): Promise<string[]> {
    if (!sessionIds.length) return Promise.resolve([])
    return this.mutate((state) => {
      const deleted: string[] = []
      for (const sessionId of sessionIds) {
        const item = state.goals[sessionId]
        if (item) {
          this.clocks.delete(item.goal.goalId)
          delete state.goals[sessionId]
          deleted.push(sessionId)
        }
      }
      return deleted
    })
  }
  assertActive(run: GoalRun) {
    if (this.storageError) throw this.storageError
    const item = this.state.goals[run.session.sessionId]
    if (!item || item.goal.goalId !== run.goalId || item.goal.status !== 'active' || item.cycle?.id !== run.cycleId)
      throw new Error('目标已停止或执行轮次已失效')
  }
  begin(session: SessionRef, continuation: boolean): Promise<GoalRun | undefined> {
    if (this.storageError) return Promise.reject(this.storageError)
    if (this.get(session)?.status !== 'active') return Promise.resolve(undefined)
    return this.mutate((state) => {
      const item = this.item(state, session)
      if (item.goal.status !== 'active') throw new Error('目标已停止')
      if (!continuation || !item.cycle) {
        item.cycle = { id: randomUUID(), activity: false, settled: false }
        item.goal.turns++
      }
      return { goalId: item.goal.goalId, cycleId: item.cycle.id, session: item.goal.session }
    })
  }
  pendingInput(session: SessionRef) {
    const item = this.state.goals[session.sessionId]
    return item?.goal.session.hostId === session.hostId && !item.goal.inputEntryId
      ? structuredClone(item.pendingInput)
      : undefined
  }
  currentRun(session: SessionRef): GoalRun | undefined {
    const item = this.state.goals[session.sessionId]
    return item?.cycle ? { goalId: item.goal.goalId, cycleId: item.cycle.id, session: item.goal.session } : undefined
  }
  update(run: GoalRun, input: GoalUpdate, canComplete: boolean) {
    this.assertActive(run)
    if (
      !input ||
      !['active', 'complete', 'blocked', 'paused'].includes(input.status) ||
      typeof input.summary !== 'string' ||
      !input.summary.trim()
    )
      throw new Error('目标更新需要有效状态和进展说明')
    if (
      input.evidence !== undefined &&
      (!Array.isArray(input.evidence) || input.evidence.some((value) => typeof value !== 'string' || !value.trim()))
    )
      throw new Error('验收证据必须是非空文字列表')
    if (input.status === 'complete' && (!canComplete || !input.evidence?.length))
      throw new Error('完成目标需要验收证据，且不能有未结束子任务、未读结果、排队输入或待答交互')
    return this.mutate((state) => {
      const item = this.item(state, run.session)
      if (item.goal.goalId !== run.goalId || item.cycle?.id !== run.cycleId || item.goal.status !== 'active')
        throw new Error('目标轮次已失效')
      const report: Report = { progress: input.progress, blockerKey: input.blockerKey }
      if ((input.status === 'blocked' || input.progress === 'blocked') && !input.blockerKey?.trim())
        throw new Error('受阻记录需要稳定的 blockerKey')
      const count = input.blockerKey && item.goal.blocker?.key === input.blockerKey ? item.goal.blocker.count + 1 : 1
      if (input.status === 'blocked' && count < 3)
        throw new Error('同一阻塞必须连续三轮，请先记录本轮受阻进展并继续核对')
      item.cycle.report = report
      item.cycle.activity ||= input.progress === 'progress' && item.goal.progress !== input.summary.trim()
      item.goal.progress = input.summary.trim()
      item.goal.updatedAt = new Date(this.now()).toISOString()
      if (input.status === 'complete') {
        item.goal.evidence = input.evidence!
        this.transition(item.goal, 'complete')
      } else if (input.status === 'blocked') this.transition(item.goal, 'blocked', input.summary)
      else if (input.status === 'paused') this.transition(item.goal, 'paused', input.summary)
      return item.goal
    })
  }
  async settled(run: GoalRun) {
    await this.mutate((state) => {
      const item = state.goals[run.session.sessionId]
      if (!item || item.goal.goalId !== run.goalId || item.cycle?.id !== run.cycleId || item.cycle.settled) return
      item.cycle.settled = true
      item.cycle.activity ||= this.activities.has(run.cycleId)
      this.activities.delete(run.cycleId)
      this.flushClock(item.goal)
      this.clocks.delete(item.goal.goalId)
      if (item.goal.status !== 'active') return
      const report = item.cycle.report
      if (report?.progress === 'blocked' && report.blockerKey) {
        item.goal.blocker = {
          key: report.blockerKey,
          count: item.goal.blocker?.key === report.blockerKey ? item.goal.blocker.count + 1 : 1,
        }
        if (item.goal.blocker.count >= 3) this.transition(item.goal, 'blocked', item.goal.progress)
      } else item.goal.blocker = undefined
      item.emptyTurns = item.cycle.activity || report?.progress === 'waiting' ? 0 : item.emptyTurns + 1
      if (item.emptyTurns >= 3) this.transition(item.goal, 'blocked', '连续三轮没有实质执行，请检查目标或模型后恢复')
    })
  }
  activity(run: GoalRun) {
    const item = this.state.goals[run.session.sessionId]
    if (item?.goal.goalId === run.goalId && item.cycle?.id === run.cycleId) this.activities.add(run.cycleId)
  }
  private flushClock(goal: Goal) {
    const clock = this.clocks.get(goal.goalId)
    if (clock) {
      goal.elapsedMs += clock.pendingMs + (clock.running ? Math.max(0, this.now() - clock.at) : 0)
      clock.at = this.now()
      clock.pendingMs = 0
    }
  }
  setRunning(session: SessionRef, running: boolean) {
    const item = this.state.goals[session.sessionId]
    if (!item) return
    const clock = this.clocks.get(item.goal.goalId)
    const pendingMs = (clock?.pendingMs ?? 0) + (clock?.running ? Math.max(0, this.now() - clock.at) : 0)
    this.clocks.set(item.goal.goalId, { at: this.now(), pendingMs, running: running && item.goal.status === 'active' })
  }
  usage(run: GoalRun, entryId: string, usage: unknown, inputEntryId?: string) {
    const current = this.state.goals[run.session.sessionId]
    if (!current || current.goal.goalId !== run.goalId || current.accounted.includes(entryId)) return Promise.resolve()
    return this.mutate((state) => {
      const item = state.goals[run.session.sessionId]
      if (!item || item.goal.goalId !== run.goalId || item.accounted.includes(entryId)) return
      item.accounted.push(entryId)
      if (inputEntryId) {
        item.goal.inputEntryId ??= inputEntryId
        item.pendingInput = undefined
      }
      this.flushClock(item.goal)
      const tokens = goalTokens(usage)
      if (tokens === undefined) item.goal.usageIncomplete = true
      else item.goal.tokensUsed += tokens
    })
  }
  async reconcile() {
    const records: Array<{ run: GoalRun; id: string; usage: unknown; inputEntryId?: string }> = []
    const scan = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return []
        throw cause
      })) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          await scan(file)
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        let run: GoalRun | undefined
        let inputEntryId: string | undefined
        for (const line of (await readFile(file, 'utf8')).split('\n')) {
          if (!line.trim()) continue
          let value: {
            id?: string
            type?: string
            customType?: string
            data?: GoalRun
            message?: { role?: string; usage?: unknown }
            usage?: unknown
          }
          try {
            value = JSON.parse(line)
          } catch {
            continue
          }
          if (value.type === 'custom' && value.customType === goalRunEntry) {
            run = value.data
            inputEntryId = undefined
          }
          if (!run?.session || this.get(run.session)?.goalId !== run.goalId || !value.id) continue
          if (value.type === 'message' && value.message?.role === 'user') {
            inputEntryId ??= value.id
            records.push({ run, id: `input:${value.id}`, usage: { totalTokens: 0 }, inputEntryId })
          }
          const usage = goalEntryUsage(value)
          if (isGoalUsageEntry(value)) records.push({ run, id: value.id, usage, inputEntryId })
        }
      }
    }
    if (Object.keys(this.state.goals).length) await scan(this.options.sessionsDirectory)
    for (const record of records) await this.usage(record.run, record.id, record.usage, record.inputEntryId)
  }
  async flush() {
    await this.pending.catch(() => {
      if (this.storageError) throw this.storageError
    })
  }
}
