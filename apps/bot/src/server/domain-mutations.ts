import { createHash, randomUUID } from 'node:crypto'
import type { AppState, Bot, Conversation, Memory, Schedule, Task, TaskProposal } from '../shared/types.js'
import { botFields } from './bot-fields.js'
import { ensureBotConversation } from './bot-conversations.js'
import { BotError, ids, requireItem, revision, text, touch } from './errors.js'
import { validateScheduleTarget } from './schedules-runtime.js'
import { nextOccurrence, validateRule } from './schedules-time.js'

function resource() {
  const now = new Date().toISOString()
  return { id: randomUUID(), revision: 1, createdAt: now, updatedAt: now }
}

export function createBot(state: AppState, input: Record<string, unknown>): Bot {
  if (Object.keys(state.bots).length >= 200) throw new BotError(409, 'limit-exceeded', '最多200个Bot')
  const bot = botFields(input, state)
  state.bots[bot.id] = bot
  ensureBotConversation(state, bot.id)
  return bot
}

export function conversationFields(
  input: Record<string, unknown>,
  state: AppState,
  current?: Conversation,
): Conversation {
  const value = { ...current, ...input }
  const kind = value.kind ?? 'direct'
  if (
    !['direct', 'group', 'qq'].includes(String(kind)) ||
    (!current && kind === 'qq') ||
    (current && kind !== current.kind)
  )
    throw new BotError(400, 'invalid-input', '会话类型无效或不可改变')
  const memberIds = ids(value.memberIds ?? [], '成员', 16)
  if (!memberIds.length || (kind === 'direct' && memberIds.length !== 1) || (kind === 'group' && memberIds.length < 2))
    throw new BotError(400, 'invalid-input', '私聊需1名Bot，群聊需2–16名Bot')
  for (const id of memberIds) requireItem(state.bots[id], '成员')
  if (current?.kind === 'direct' && current.coordinatorId !== memberIds[0])
    throw new BotError(400, 'invalid-input', '私聊角色固定，请选择对应 Bot')
  const coordinatorId = text(value.coordinatorId ?? memberIds[0], '协调者', 128)
  if (!memberIds.includes(coordinatorId)) throw new BotError(400, 'invalid-input', '协调者须为当前成员')
  const memberSince = { ...current?.memberSince }
  for (const id of memberIds) if (!current?.memberIds.includes(id)) memberSince[id] = (current?.sequence ?? 0) + 1
  for (const key of ['pinned', 'archived', 'collaborationEnabled'] as const)
    if (value[key] !== undefined && typeof value[key] !== 'boolean')
      throw new BotError(400, 'invalid-input', `${key}须为布尔值`)
  return {
    ...(current ?? resource()),
    kind: kind as Conversation['kind'],
    name: text(value.name ?? state.bots[coordinatorId].name, '会话名称', 120),
    memberIds,
    coordinatorId,
    memberSince,
    pinned: value.pinned === true,
    archived: value.archived === true,
    collaborationEnabled:
      kind === 'group'
        ? value.collaborationEnabled === undefined
          ? !current
          : value.collaborationEnabled === true
        : undefined,
    sequence: current?.sequence ?? 0,
  }
}

export function createConversation(state: AppState, input: Record<string, unknown>): Conversation {
  if (Object.keys(state.conversations).length >= 2000) throw new BotError(409, 'limit-exceeded', '最多2000个会话')
  const conversation = conversationFields(input, state)
  if (conversation.kind === 'direct') return ensureBotConversation(state, conversation.coordinatorId)
  state.conversations[conversation.id] = conversation
  return conversation
}

export function saveMemory(state: AppState, input: Record<string, unknown>, current?: Memory): Memory {
  if (current) revision(current, input.revision)
  const value = { ...current, ...input }
  if (!['owner', 'bot', 'conversation'].includes(String(value.scope)))
    throw new BotError(400, 'invalid-input', '记忆范围无效')
  const targetId = value.scope === 'owner' ? undefined : text(value.targetId, '记忆目标', 128)
  if (value.scope === 'bot') requireItem(state.bots[targetId!], 'Bot')
  if (value.scope === 'conversation') requireItem(state.conversations[targetId!], '会话')
  const sourceMessageId = value.sourceMessageId ? text(value.sourceMessageId, '来源消息', 128) : undefined
  if (sourceMessageId) {
    const source = requireItem(state.messages[sourceMessageId], '来源消息')
    if (value.scope === 'conversation' && source.conversationId !== targetId)
      throw new BotError(403, 'forbidden', '来源不属于该会话')
  }
  const memory: Memory = {
    ...(current ?? resource()),
    scope: value.scope as Memory['scope'],
    targetId,
    title: text(value.title, '标题', 120),
    content: text(value.content, '记忆内容', 16000),
    sourceMessageId,
  }
  if (current) touch(memory)
  state.memories[memory.id] = memory
  return memory
}

export function scheduleFields(input: Record<string, unknown>, current?: Schedule): Schedule {
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
    ...(current ?? resource()),
    revision: current ? current.revision + 1 : 1,
    updatedAt: now,
    name: text(value.name, '名称', 80),
    conversationId: text(value.conversationId, '会话', 200),
    botId: text(value.botId, 'Bot', 200),
    prompt: text(value.prompt, '执行内容', 32000),
    enabled: value.enabled !== false,
    kind: value.kind as Schedule['kind'],
    timezone: text(value.timezone, '时区', 100),
    at: typeof value.at === 'string' ? value.at : '',
    time: typeof value.time === 'string' ? value.time : '',
    weekdays: [...new Set(weekdays as number[])],
    notification: value.notification === 'qq' ? 'qq' : 'web',
    lastRunAt: current?.lastRunAt,
    activeTaskId: current?.activeTaskId,
    executionGrant: randomUUID(),
  }
  validateRule(schedule)
  if (schedule.kind === 'once') schedule.at = new Date(schedule.at).toISOString()
  schedule.nextRunAt = schedule.enabled ? nextOccurrence(schedule) : undefined
  if (schedule.enabled && !schedule.nextRunAt)
    throw new BotError(400, 'invalid-input', '启用定时任务须有未来的执行时间')
  return schedule
}

export function createSchedule(state: AppState, input: Record<string, unknown>): Schedule {
  const schedule = scheduleFields(input)
  validateScheduleTarget(state, schedule)
  if (Object.keys(state.schedules).length >= 500) throw new BotError(409, 'limit-exceeded', '最多保存 500 个定时任务')
  state.schedules[schedule.id] = schedule
  return schedule
}

function allowFields(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new BotError(400, 'invalid-input', '草稿包含不支持的字段，请重新提出')
}

export function applyTaskProposal(
  state: AppState,
  proposal: TaskProposal,
  taskId: string,
  interactionId: string,
): unknown {
  const task: Task = requireItem(state.tasks[taskId], '任务')
  const interaction = requireItem(
    task.interactions?.find((item) => item.id === interactionId),
    '确认请求',
  )
  if (
    interaction.taskId !== taskId ||
    interaction.kind !== 'proposal' ||
    interaction.status !== 'answered' ||
    interaction.response?.decision !== 'approve' ||
    JSON.stringify(interaction.proposal) !== JSON.stringify(proposal)
  )
    throw new BotError(409, 'interaction-conflict', '此草稿尚未确认或内容已经变化')
  const operationId = `proposal:${taskId}:${interactionId}`
  const hash = createHash('sha256').update(JSON.stringify(proposal)).digest('hex')
  const receipt = state.operations[operationId]
  if (receipt) {
    if (receipt.hash !== hash) throw new BotError(409, 'idempotency-conflict', '草稿确认内容不一致')
    return receipt.result
  }
  const bot = requireItem(state.bots[task.botId], 'Bot')
  const conversation = requireItem(state.conversations[task.conversationId], '会话')
  if (!bot.enabled || !conversation.memberIds.includes(bot.id) || !['running', 'waiting'].includes(task.status))
    throw new BotError(409, 'task-unavailable', '任务已经停止或执行权限已变化')
  const value = proposal.value
  let result: unknown
  switch (proposal.kind) {
    case 'create-bot':
      allowFields(value, ['name', 'description', 'instructions', 'modelId'])
      result = createBot(state, value)
      break
    case 'create-group':
      allowFields(value, ['name', 'memberIds', 'coordinatorId', 'collaborationEnabled'])
      result = createConversation(state, { ...value, kind: 'group' })
      break
    case 'create-schedule':
      allowFields(value, [
        'name',
        'botId',
        'prompt',
        'enabled',
        'kind',
        'timezone',
        'at',
        'time',
        'weekdays',
        'notification',
      ])
      result = createSchedule(state, { ...value, conversationId: conversation.id, botId: value.botId ?? bot.id })
      break
    case 'remember': {
      allowFields(value, ['scope', 'targetId', 'title', 'content'])
      const scope = value.scope ?? (conversation.kind === 'group' ? 'conversation' : 'bot')
      result = saveMemory(state, {
        ...value,
        scope,
        targetId: value.targetId ?? (scope === 'bot' ? bot.id : conversation.id),
        sourceMessageId: task.sourceMessageId,
      })
      break
    }
    default:
      throw new BotError(400, 'invalid-input', '草稿类型无效')
  }
  state.operations[operationId] = { hash, result, createdAt: new Date().toISOString() }
  return result
}
