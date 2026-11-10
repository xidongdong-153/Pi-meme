import { randomUUID } from 'node:crypto'
import type { AppState, Schedule, ScheduleRun } from '../shared/types.js'
import type { BotServices } from './contracts.js'
import { BotError } from './errors.js'
import { nextOccurrence } from './schedules-time.js'

const activeStatuses = new Set(['queued', 'running', 'waiting', 'stopping'])
const nowIso = () => new Date().toISOString()
const resource = () => ({ id: randomUUID(), revision: 1, createdAt: nowIso(), updatedAt: nowIso() })

export function validateScheduleTarget(state: AppState, schedule: Schedule) {
  const conversation = state.conversations[schedule.conversationId]
  const bot = state.bots[schedule.botId]
  if (!conversation || conversation.archived || !conversation.memberIds.includes(schedule.botId))
    throw new BotError(400, 'invalid-input', '请选择有效会话及其成员 Bot')
  if (!bot?.enabled || (!schedule.executionGrant && !bot.capabilities.includes('schedules')))
    throw new BotError(403, 'forbidden', '执行 Bot 未启用或未获定时安排授权')
  if (
    schedule.notification === 'qq' &&
    (conversation.kind !== 'qq' ||
      !state.qq.enabled ||
      !state.qq.boundUserId ||
      conversation.qqUserId !== state.qq.boundUserId ||
      conversation.qqAppId !== state.qq.appId)
  )
    throw new BotError(409, 'capability-unavailable', 'QQ 通知需要当前已绑定的 QQ 来源会话')
}

export function validateScheduleAdmission(state: AppState, run: ScheduleRun) {
  const snapshot = run.scheduleSnapshot
  const current = state.schedules[run.scheduleId]
  if (!snapshot || !current || run.status !== 'running' || current.executionGrant !== snapshot.executionGrant)
    throw new BotError(403, 'forbidden', '定时任务已更改、暂停或删除，本次接纳已取消')
  validateScheduleTarget(state, snapshot)
}

export function createScheduleRuntime(services: BotServices) {
  const configuredLateness = process.env.PI_BOT_SCHEDULE_MAX_LATENESS_MS
  const maxLatenessMs = configuredLateness === undefined ? 60_000 : Number(configuredLateness)
  if (!Number.isInteger(maxLatenessMs) || maxLatenessMs < 0 || maxLatenessMs > 300_000)
    throw new BotError(400, 'invalid-input', 'PI_BOT_SCHEDULE_MAX_LATENESS_MS 必须是 0–300000 的整数')
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking: Promise<void> | undefined
  let closed = false
  const accepting = new Set<string>()

  async function admit(run: ScheduleRun) {
    if (closed || accepting.has(run.id) || !run.scheduleSnapshot) return
    accepting.add(run.id)
    const snapshot = run.scheduleSnapshot
    try {
      const state = services.store.read()
      // A saved inbox identity is an admission receipt, even when later configuration was revoked.
      // Recover that receipt without creating new work; fresh admission still checks current grants.
      if (!state.inboundIds[`input:schedule-run:${run.id}`]) validateScheduleAdmission(state, run)
      const receipt = await services.acceptMessage({
        conversationId: snapshot.conversationId,
        content: snapshot.prompt,
        recipientIds: [snapshot.botId],
        source: 'schedule',
        notification: snapshot.notification,
        requestId: `schedule-run:${run.id}`,
        scheduleRunId: run.id,
      })
      await services.store.update((draft) => {
        const current = draft.scheduleRuns[run.id]
        if (!current || current.status !== 'running') return
        current.taskIds = receipt.taskIds
        current.revision++
        current.updatedAt = nowIso()
        const schedule = draft.schedules[run.scheduleId]
        if (schedule) {
          schedule.activeTaskId = receipt.taskIds[0]
          schedule.revision++
          schedule.updatedAt = nowIso()
        }
      })
    } catch (cause) {
      await services.store.update((draft) => {
        const current = draft.scheduleRuns[run.id]
        if (!current) return
        current.status = 'failed'
        current.error = cause instanceof BotError ? cause.message : '运行接纳失败；请查看关联会话和任务后再手动运行'
        current.revision++
        current.updatedAt = nowIso()
      })
    } finally {
      accepting.delete(run.id)
    }
  }

  async function claim(scheduleId: string, dueAt: string, manual: boolean) {
    const run = await services.store.update((draft) => {
      const schedule = draft.schedules[scheduleId]
      if (!schedule) throw new BotError(404, 'not-found', '计划不存在')
      validateScheduleTarget(draft, schedule)
      const active = Object.values(draft.scheduleRuns).some(
        (entry) => entry.scheduleId === schedule.id && entry.status === 'running',
      )
      const busy = Object.values(draft.tasks).some(
        (entry) => entry.conversationId === schedule.conversationId && activeStatuses.has(entry.status),
      )
      if (manual && (active || busy)) throw new BotError(409, 'conflict', '该计划或会话已有运行中的任务')
      if (!manual && (!schedule.enabled || schedule.nextRunAt !== dueAt)) return undefined
      if (
        !manual &&
        Object.values(draft.scheduleRuns).some(
          (entry) =>
            entry.scheduleId === scheduleId && entry.dueAt === dueAt && entry.scheduleRevision === schedule.revision,
        )
      )
        return undefined
      const expired = !manual && Date.now() - Date.parse(dueAt) > maxLatenessMs
      const result: ScheduleRun = {
        ...resource(),
        scheduleId,
        dueAt,
        status: active || busy || expired ? 'skipped' : 'running',
        taskIds: [],
        scheduleRevision: schedule.revision,
        scheduleSnapshot: structuredClone(schedule),
        ...(expired
          ? { error: '超过允许延迟，本次已跳过且未补跑' }
          : active || busy
            ? { error: '计划或会话忙碌，本次已跳过' }
            : {}),
      }
      draft.scheduleRuns[result.id] = result
      if (!manual) {
        schedule.lastRunAt = dueAt
        schedule.nextRunAt = nextOccurrence(schedule, Date.now())
        if (schedule.kind === 'once') schedule.enabled = false
        schedule.revision++
        schedule.updatedAt = nowIso()
      }
      return result
    })
    if (run?.status === 'running') await admit(run)
    return services.store.read().scheduleRuns[run?.id ?? ''] ?? run
  }

  async function reconcile() {
    const snapshot = services.store.read()
    for (const run of Object.values(snapshot.scheduleRuns)) {
      if (run.status !== 'running') continue
      if (run.taskIds.length === 0) {
        await admit(run)
        continue
      }
      const tasks = run.taskIds.map((id) => snapshot.tasks[id])
      if (tasks.some((task) => task && activeStatuses.has(task.status))) continue
      await services.store.update((draft) => {
        const current = draft.scheduleRuns[run.id]
        if (!current || current.status !== 'running') return
        const outcomes = current.taskIds.map((id) => draft.tasks[id])
        if (outcomes.some((task) => task && activeStatuses.has(task.status))) return
        current.status = outcomes.every((task) => task?.status === 'completed') ? 'completed' : 'failed'
        current.error =
          current.status === 'failed'
            ? (outcomes.find((task) => task?.error)?.error ?? '执行未完成；请查看关联任务')
            : undefined
        current.revision++
        current.updatedAt = nowIso()
        const schedule = draft.schedules[run.scheduleId]
        if (schedule && (!schedule.activeTaskId || run.taskIds.includes(schedule.activeTaskId))) {
          schedule.activeTaskId = undefined
          schedule.revision++
          schedule.updatedAt = nowIso()
        }
      })
    }
  }

  async function tick() {
    await reconcile()
    for (const schedule of Object.values(services.store.read().schedules)) {
      if (closed) return
      if (!schedule.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > Date.now()) continue
      try {
        await claim(schedule.id, schedule.nextRunAt, false)
      } catch (cause) {
        await services.store.update((draft) => {
          const current = draft.schedules[schedule.id]
          if (!current || current.nextRunAt !== schedule.nextRunAt) return
          const skipped: ScheduleRun = {
            ...resource(),
            scheduleId: schedule.id,
            dueAt: schedule.nextRunAt!,
            status: 'skipped',
            taskIds: [],
            error: cause instanceof BotError ? cause.message : '计划当前不可执行',
          }
          draft.scheduleRuns[skipped.id] = skipped
          current.nextRunAt = nextOccurrence(current, Date.now())
          if (current.kind === 'once') current.enabled = false
          current.revision++
          current.updatedAt = nowIso()
        })
      }
    }
  }

  return {
    policy: { maxLatenessMs, downtime: 'skip' as const },
    async run(id: string) {
      return claim(id, nowIso(), true)
    },
    async start() {
      if (timer) return
      closed = false
      // Record downtime misses once, advance from now; never replay elapsed calendar triggers.
      await services.store.update((draft) => {
        for (const schedule of Object.values(draft.schedules)) {
          if (!schedule.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) >= Date.now()) continue
          const skipped: ScheduleRun = {
            ...resource(),
            scheduleId: schedule.id,
            dueAt: schedule.nextRunAt,
            status: 'skipped',
            taskIds: [],
            scheduleRevision: schedule.revision,
            error: '停机期间错过执行，未补跑',
          }
          draft.scheduleRuns[skipped.id] = skipped
          schedule.nextRunAt = nextOccurrence(schedule, Date.now())
          if (schedule.kind === 'once') schedule.enabled = false
          schedule.revision++
          schedule.updatedAt = nowIso()
        }
      })
      await reconcile()
      timer = setInterval(() => {
        if (!ticking && !closed) {
          ticking = tick()
            .catch(() => {})
            .finally(() => {
              ticking = undefined
            })
        }
      }, 1000)
      timer.unref()
    },
    async close() {
      closed = true
      if (timer) clearInterval(timer)
      timer = undefined
      await ticking
    },
  }
}
