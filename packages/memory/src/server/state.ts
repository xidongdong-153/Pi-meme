import type {
  MemoryConfig,
  MemoryEntry,
  MemoryJob,
  MemoryLearningSource,
  MemoryTurnTicket,
  MemoryUsageRecord,
} from '@pi-meme/contracts/memory'
import { entryInput, integer, keys, memoryLimits, object, text } from '../shared/validation'

export type StoredJob = MemoryJob & {
  ticket: MemoryTurnTicket
  sources: MemoryLearningSource[]
  dueAt: number
  attempts: number
}
export type Attempt = {
  id: string
  jobId: string
  date: string
  reserved: number
  finished: boolean
  purpose: MemoryUsageRecord['purpose']
  model: MemoryTurnTicket['model']
  timestamp: string
}
export type MemoryState = {
  version: 1
  config: MemoryConfig
  revision: number
  epoch: number
  learningEpoch: number
  sequence: number
  entries: MemoryEntry[]
  tickets: MemoryTurnTicket[]
  jobs: StoredJob[]
  invalidSessions: string[]
  pausedSessions: string[]
  invalidSources: string[]
  processed: string[]
  sessionCompleted: Record<string, number>
  budgets: Record<string, { tokens: number; reserved: number; calls: number; unknownCalls: number }>
  attempts: Attempt[]
  usageOutbox: MemoryUsageRecord[]
  mutations: Array<{ key: string; input: string; result: unknown }>
}
export function initialState(): MemoryState {
  return {
    version: 1,
    config: { enabled: false, autoLearn: true, model: null, dailyTokenBudget: 100000, revision: 0 },
    revision: 0,
    epoch: 0,
    learningEpoch: 0,
    sequence: 0,
    entries: [],
    tickets: [],
    jobs: [],
    invalidSessions: [],
    pausedSessions: [],
    invalidSources: [],
    processed: [],
    sessionCompleted: {},
    budgets: {},
    attempts: [],
    usageOutbox: [],
    mutations: [],
  }
}
export function validateState(value: unknown): asserts value is MemoryState {
  object(value)
  keys(value, Object.keys(initialState()))
  if (value.version !== 1) throw new Error('不支持的记忆存储版本')
  for (const key of ['revision', 'epoch', 'learningEpoch', 'sequence']) integer(value[key], key)
  object(value.config)
  keys(value.config, ['enabled', 'autoLearn', 'model', 'dailyTokenBudget', 'revision'])
  if (typeof value.config.enabled !== 'boolean' || typeof value.config.autoLearn !== 'boolean')
    throw new Error('记忆开关无效')
  integer(value.config.revision, '配置修订')
  integer(value.config.dailyTokenBudget, '每日额度', 20000, 1000000)
  if (value.config.model !== null) {
    object(value.config.model)
    keys(value.config.model, ['provider', 'id'])
    text(value.config.model.provider, '模型服务商', 256)
    text(value.config.model.id, '模型标识', 256)
  }
  const bounds = {
    entries: memoryLimits.entries,
    tickets: 1000,
    jobs: 200,
    attempts: 10000,
    usageOutbox: 1000,
    mutations: 256,
  }
  for (const [key, max] of Object.entries(bounds)) {
    if (!Array.isArray(value[key]) || value[key].length > max) throw new Error(`记忆${key}超限或格式无效`)
  }
  const entries = value.entries as MemoryEntry[]
  const ids = new Set<string>()
  for (const entry of entries) {
    object(entry)
    entryInput({ title: entry.title, content: entry.content, scope: entry.scope })
    text(entry.id, '记忆标识', 256)
    if (ids.has(entry.id)) throw new Error('重复的记忆标识')
    ids.add(entry.id)
    integer(entry.revision, '条目修订')
    if (
      !['manual', 'auto'].includes(entry.origin) ||
      typeof entry.locked !== 'boolean' ||
      !Array.isArray(entry.sources)
    )
      throw new Error('记忆条目格式无效')
    for (const source of entry.sources) validateSource(source)
    text(entry.createdAt, '创建时间', 64)
    text(entry.updatedAt, '更新时间', 64)
  }
  for (const key of ['invalidSessions', 'pausedSessions', 'invalidSources', 'processed']) {
    if (!Array.isArray(value[key]) || value[key].length > 50000) throw new Error('记忆来源标记超限')
    for (const item of value[key]) text(item, '来源标记', 1024)
  }
  object(value.sessionCompleted)
  for (const timestamp of Object.values(value.sessionCompleted)) integer(timestamp, '会话时间')
  object(value.budgets)
  for (const [date, budget] of Object.entries(value.budgets)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('预算日期无效')
    object(budget)
    for (const key of ['tokens', 'reserved', 'calls', 'unknownCalls']) integer(budget[key], key)
  }
  for (const job of value.jobs as StoredJob[]) {
    object(job)
    text(job.id, '任务标识', 256)
    if (
      ![
        'waiting',
        'extracting',
        'consolidating',
        'completed',
        'failed',
        'cancelled',
        'budget-paused',
        'interrupted',
      ].includes(job.state)
    )
      throw new Error('任务状态无效')
    validateTicket(job.ticket)
    object(job.session)
    if (
      job.session.hostId !== job.ticket.session.hostId ||
      job.session.sessionId !== job.ticket.session.sessionId ||
      job.projectId !== job.ticket.projectId
    )
      throw new Error('任务与来源轮次身份不一致')
    text(job.createdAt, '任务创建时间', 64)
    text(job.updatedAt, '任务更新时间', 64)
    if (typeof job.unknownUsage !== 'boolean') throw new Error('任务用量状态无效')
    integer(job.dueAt, '任务时间')
    integer(job.attempts, '任务次数')
    integer(job.tokens, '任务用量')
    if (!Array.isArray(job.sources) || job.sources.length > 100) throw new Error('任务来源无效')
    for (const item of job.sources) {
      validateSource(item.source)
      if (item.source.session.hostId !== job.session.hostId || item.source.session.sessionId !== job.session.sessionId)
        throw new Error('任务来源会话不一致')
      text(item.text, '来源正文', 16000)
      if (item.role !== 'user' && item.role !== 'assistant') throw new Error('来源角色无效')
    }
  }
  for (const ticket of value.tickets as MemoryTurnTicket[]) validateTicket(ticket)
  for (const attempt of value.attempts as Attempt[]) {
    text(attempt.id, '调用标识', 256)
    text(attempt.jobId, '调用任务', 256)
    text(attempt.date, '调用日期', 64)
    integer(attempt.reserved, '调用预留')
    if (typeof attempt.finished !== 'boolean') throw new Error('调用状态无效')
    if (!['memory.extract', 'memory.consolidate'].includes(attempt.purpose)) throw new Error('调用用途无效')
    text(attempt.model.provider, '调用模型服务商', 256)
    text(attempt.model.id, '调用模型', 256)
    text(attempt.timestamp, '调用时间', 64)
  }
  for (const usage of value.usageOutbox as MemoryUsageRecord[]) {
    text(usage.attemptId, '用量标识', 256)
    if (
      !['memory.extract', 'memory.consolidate'].includes(usage.purpose) ||
      !['completed', 'failed', 'unknown'].includes(usage.outcome)
    )
      throw new Error('用量记录无效')
    if (usage.tokens !== undefined) integer(usage.tokens, '用量')
    object(usage.model)
    text(usage.model.provider, '用量模型服务商', 256)
    text(usage.model.id, '用量模型', 256)
    text(usage.timestamp, '用量时间', 64)
    if (usage.cost !== undefined && (!Number.isFinite(usage.cost) || usage.cost < 0)) throw new Error('用量费用无效')
  }
  for (const mutation of value.mutations as MemoryState['mutations']) {
    text(mutation.key, '幂等键', 256)
    text(mutation.input, '幂等输入', 32000)
  }
}
export function validateSource(value: unknown): asserts value is import('@pi-meme/contracts/memory').MemorySource {
  object(value)
  keys(value, ['id', 'session', 'entryId', 'revision', 'excerpt'])
  text(value.id, '来源标识', 1024)
  text(value.entryId, '原生条目标识', 256)
  text(value.revision, '来源修订', 256)
  if (typeof value.excerpt !== 'string' || value.excerpt.length > 1000) throw new Error('来源摘录超限')
  object(value.session)
  text(value.session.hostId, '来源Host', 256)
  text(value.session.sessionId, '来源会话', 256)
}
export function validateTicket(value: unknown): asserts value is MemoryTurnTicket {
  object(value)
  text(value.id, '轮次标识', 256)
  text(value.projectId, '项目标识', 256)
  object(value.session)
  text(value.session.hostId, 'Host标识', 256)
  text(value.session.sessionId, '会话标识', 256)
  object(value.model)
  text(value.model.provider, '模型服务商', 256)
  text(value.model.id, '模型', 256)
  for (const key of ['epoch', 'learningEpoch', 'sequence']) integer(value[key], key)
  text(value.startedAt, '轮次时间', 64)
}
