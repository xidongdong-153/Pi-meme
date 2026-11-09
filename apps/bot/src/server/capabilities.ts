import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import type { Schedule } from '../shared/types.js'
import type { BotApp, BotServices, CapabilityAdapter } from './contracts.js'
import { BotError } from './errors.js'
import { createImageGenerator } from './images-generate.js'
import { createScheduleRuntime, validateScheduleTarget } from './schedules-runtime.js'
import { nextOccurrence, previewOccurrences, validateRule } from './schedules-time.js'
import { explorePublicPage } from './web-public.js'

async function body(context: Context): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = await context.req.json()
  } catch {
    throw new BotError(400, 'invalid-input', '请求内容须为 JSON 对象')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BotError(400, 'invalid-input', '请求内容须为 JSON 对象')
  return value as Record<string, unknown>
}

function text(value: unknown, name: string, maximum: number, fallback?: string) {
  const result = value === undefined ? fallback : value
  if (typeof result !== 'string' || !result.trim() || result.length > maximum)
    throw new BotError(400, 'invalid-input', `${name}须为 1–${maximum} 字符`)
  return result.trim()
}

function revision(current: { revision: number }, expected: unknown) {
  if (!Number.isInteger(expected) || current.revision !== expected)
    throw new BotError(409, 'revision-conflict', '计划已变化，请重新读取后保存', { revision: current.revision })
}

function scheduleFields(input: Record<string, unknown>, current?: Schedule): Schedule {
  const now = new Date().toISOString()
  const value = { ...current, ...input }
  const weekdays = value.weekdays ?? []
  if (!Array.isArray(weekdays) || weekdays.length > 7 || weekdays.some((day) => typeof day !== 'number'))
    throw new BotError(400, 'invalid-input', '星期必须是 0–6 的整数列表')
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    throw new BotError(400, 'invalid-input', '启用状态须为布尔值')
  if (value.notification !== undefined && !['web', 'qq'].includes(String(value.notification)))
    throw new BotError(400, 'invalid-input', '通知渠道须为 web 或 qq')
  const schedule: Schedule = {
    id: current?.id ?? randomUUID(),
    revision: current ? current.revision + 1 : 1,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    name: text(value.name, '名称', 80),
    conversationId: text(value.conversationId, '会话', 200),
    botId: text(value.botId, 'Bot', 200),
    prompt: text(value.prompt, '执行内容', 32_000),
    enabled: value.enabled === undefined ? true : (value.enabled as boolean),
    kind: value.kind as Schedule['kind'],
    timezone: text(value.timezone, '时区', 100),
    at: typeof value.at === 'string' ? value.at : '',
    time: typeof value.time === 'string' ? value.time : '',
    weekdays: [...new Set(weekdays as number[])],
    notification: value.notification === 'qq' ? 'qq' : 'web',
    lastRunAt: current?.lastRunAt,
    activeTaskId: current?.activeTaskId,
  }
  validateRule(schedule)
  if (schedule.kind === 'once') schedule.at = new Date(schedule.at).toISOString()
  schedule.nextRunAt = schedule.enabled ? nextOccurrence(schedule) : undefined
  if (schedule.enabled && !schedule.nextRunAt) throw new BotError(400, 'invalid-input', '启用计划须有未来的执行时间')
  return schedule
}

export function registerCapabilityRoutes(app: BotApp, services: BotServices): CapabilityAdapter {
  const shutdown = new AbortController()
  const scheduler = createScheduleRuntime(services)
  const generateImage = createImageGenerator(services, shutdown.signal)
  const imageCalls = new Set<ReturnType<typeof generateImage>>()
  const generate: typeof generateImage = (input, signal) => {
    const call = generateImage(input, signal)
    imageCalls.add(call)
    void call.finally(() => imageCalls.delete(call)).catch(() => {})
    return call
  }
  const explore = async (input: { url: string }, signal?: AbortSignal) => {
    const state = services.store.read()
    if (!state.settings.webEnabled) throw new BotError(409, 'capability-unavailable', '当前部署未启用公开网页探索')
    if (typeof input.url !== 'string' || input.url.length > 4000)
      throw new BotError(400, 'invalid-input', '网页地址不能超过 4000 字符')
    const combined = AbortSignal.any([shutdown.signal, ...(signal ? [signal] : [])])
    try {
      return await explorePublicPage(input.url, state.settings.allowedWebDomains, combined)
    } catch (cause) {
      if (cause instanceof BotError) throw cause
      throw new BotError(
        502,
        'upstream-unavailable',
        combined.aborted ? '网页探索已中断' : '无法读取公开网页；站点可能不可达或请求超时',
      )
    }
  }

  app.get('/api/v1/schedules', (context) =>
    context.json({ items: Object.values(services.store.read().schedules), policy: scheduler.policy }),
  )
  app.get('/api/v1/schedules/policy', (context) => context.json(scheduler.policy))
  app.post('/api/v1/schedules/preview', async (context) => {
    const input = await body(context)
    const rule = {
      kind: input.kind as Schedule['kind'],
      timezone: text(input.timezone, '时区', 100),
      at: typeof input.at === 'string' ? input.at : '',
      time: typeof input.time === 'string' ? input.time : '',
      weekdays: (input.weekdays ?? []) as number[],
    }
    validateRule(rule)
    return context.json(previewOccurrences(rule))
  })
  app.post('/api/v1/schedules', async (context) => {
    const schedule = scheduleFields(await body(context))
    await services.store.update((draft) => {
      validateScheduleTarget(draft, schedule)
      if (Object.keys(draft.schedules).length >= 500) throw new BotError(409, 'limit-exceeded', '最多保存 500 个计划')
      draft.schedules[schedule.id] = schedule
    })
    return context.json(schedule, 201)
  })
  app.get('/api/v1/schedules/:id', (context) => {
    const schedule = services.store.read().schedules[context.req.param('id')]
    if (!schedule) throw new BotError(404, 'not-found', '计划不存在')
    return context.json(schedule)
  })
  app.patch('/api/v1/schedules/:id', async (context) => {
    const input = await body(context)
    const schedule = await services.store.update((draft) => {
      const current = draft.schedules[context.req.param('id')]
      if (!current) throw new BotError(404, 'not-found', '计划不存在')
      revision(current, input.revision)
      const updated = scheduleFields(input, current)
      validateScheduleTarget(draft, updated)
      draft.schedules[updated.id] = updated
      return updated
    })
    return context.json(schedule)
  })
  app.delete('/api/v1/schedules/:id', async (context) => {
    const input =
      context.req.query('revision') === undefined
        ? await body(context)
        : { revision: Number(context.req.query('revision')) }
    await services.store.update((draft) => {
      const schedule = draft.schedules[context.req.param('id')]
      if (!schedule) throw new BotError(404, 'not-found', '计划不存在')
      revision(schedule, input.revision)
      if (Object.values(draft.scheduleRuns).some((run) => run.scheduleId === schedule.id && run.status === 'running'))
        throw new BotError(409, 'active-run', '该计划仍有运行中的任务；请先停止或等待本次运行结束')
      // Historical tasks and outputs remain after removing their inactive rule.
      delete draft.schedules[schedule.id]
    })
    return context.json({ deleted: true })
  })
  for (const action of ['pause', 'resume'] as const) {
    app.post(`/api/v1/schedules/:id/${action}`, async (context) => {
      const input = await body(context)
      const schedule = await services.store.update((draft) => {
        const current = draft.schedules[context.req.param('id')]
        if (!current) throw new BotError(404, 'not-found', '计划不存在')
        revision(current, input.revision)
        const updated = scheduleFields({ enabled: action === 'resume' }, current)
        if (updated.enabled) validateScheduleTarget(draft, updated)
        draft.schedules[updated.id] = updated
        return updated
      })
      return context.json(schedule)
    })
  }
  app.post('/api/v1/schedules/:id/run', async (context) =>
    context.json(await scheduler.run(context.req.param('id')), 202),
  )
  app.get('/api/v1/schedules/:id/runs', (context) =>
    context.json({
      items: Object.values(services.store.read().scheduleRuns)
        .filter((run) => run.scheduleId === context.req.param('id'))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    }),
  )
  app.post('/api/v1/schedules/:id/runs/:runId/stop', async (context) => {
    const run = services.store.read().scheduleRuns[context.req.param('runId')]
    if (!run || run.scheduleId !== context.req.param('id')) throw new BotError(404, 'not-found', '运行记录不存在')
    if (run.status === 'running' && run.taskIds.length === 0)
      throw new BotError(409, 'conflict', '本次运行正在接纳任务，请稍后重读并停止')
    const results = await Promise.all(run.taskIds.map((id) => services.stopTask(id)))
    return context.json({ taskIds: [...new Set(results.flatMap((result) => result.taskIds))] })
  })

  for (const prefix of ['/api/v1/generations', '/api/v1/images/generations']) {
    app.get(prefix, (context) => context.json({ items: Object.values(services.store.read().generations) }))
    app.get(`${prefix}/:id`, (context) => {
      const generation = services.store.read().generations[context.req.param('id')]
      if (!generation) throw new BotError(404, 'not-found', '生图记录不存在')
      return context.json(generation)
    })
    app.post(prefix, async (context) => {
      const input = await body(context)
      const result = await generate(
        {
          conversationId: text(input.conversationId, '来源会话', 200),
          prompt: text(input.prompt, '图片提示词', 16_000),
          modelId: input.modelId === undefined ? undefined : text(input.modelId, '图片模型', 200),
          previousGenerationId:
            input.previousGenerationId === undefined ? undefined : text(input.previousGenerationId, '原生图记录', 200),
          confirmUnknown: input.confirmUnknown === true,
        },
        context.req.raw.signal,
      )
      return context.json(result, 201)
    })
  }
  app.post('/api/v1/explore', async (context) => {
    const input = await body(context)
    const botId = text(input.botId, 'Bot', 200)
    const bot = services.store.read().bots[botId]
    if (!bot?.enabled || !bot.capabilities.includes('web'))
      throw new BotError(403, 'forbidden', '该 Bot 未获公开网页探索授权')
    return context.json({ content: await explore({ url: text(input.url, '网页地址', 4000) }, context.req.raw.signal) })
  })

  return {
    async start() {
      await services.store.update((draft) => {
        for (const generation of Object.values(draft.generations)) {
          if (!['pending', 'running'].includes(generation.status)) continue
          generation.status = 'unknown'
          generation.error = '服务中断，生成结果与费用待供应商核对；未自动重试'
          generation.cost = null
          generation.revision++
          generation.updatedAt = new Date().toISOString()
        }
      })
      await scheduler.start()
    },
    async close() {
      shutdown.abort()
      await scheduler.close()
      await Promise.allSettled([...imageCalls])
    },
    generateImage: generate,
    explore,
  }
}
