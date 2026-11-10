import { randomUUID } from 'node:crypto'
import type { AppState, Bot, Conversation, Memory, Schedule, Task } from '../shared/types.js'
import { botFields } from './bot-fields.js'
import { ensureBotConversation } from './bot-conversations.js'
import { BotError, ids, requireItem, revision, text, touch } from './errors.js'
import { validateScheduleTarget } from './schedules-runtime.js'
import { nextOccurrence, validateRule } from './schedules-time.js'
import { fallbackDefaultAssistant } from './model-settings.js'

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

export function validateBotRemoval(state: AppState, id: string, expected: unknown, completingTaskId?: string): Bot {
  const bot = requireItem(state.bots[id], 'Bot')
  revision(bot, expected)
  if (
    Object.values(state.tasks).some(
      (task) =>
        task.botId === id &&
        task.id !== completingTaskId &&
        ['queued', 'running', 'waiting', 'stopping'].includes(task.status),
    )
  )
    throw new BotError(409, 'active-tasks', '请先结束该 Bot 的其他任务')
  if (
    Object.values(state.conversations).some(
      (conversation) =>
        !conversation.archived &&
        conversation.kind === 'group' &&
        conversation.memberIds.includes(id) &&
        conversation.memberIds.filter((member) => member !== id).length < 2,
    )
  )
    throw new BotError(409, 'resource-in-use', '请先调整成员不足两名的群组，或归档该群组')
  if (
    state.qq.defaultBotId === id ||
    Object.values(state.schedules).some((schedule) => schedule.botId === id && schedule.enabled) ||
    Object.values(state.conversations).some(
      (conversation) => !conversation.archived && conversation.kind !== 'direct' && conversation.coordinatorId === id,
    )
  )
    throw new BotError(409, 'resource-in-use', '请先替换默认接待和协调者，或暂停关联的定时任务')
  return bot
}

export function deleteBot(state: AppState, id: string, expected: unknown) {
  const bot = validateBotRemoval(state, id, expected)
  delete state.bots[id]
  fallbackDefaultAssistant(state, id)
  for (const conversation of Object.values(state.conversations)) {
    if (!conversation.memberIds.includes(bot.id) || (conversation.archived && conversation.kind === 'group')) continue
    if (conversation.kind === 'direct') conversation.archived = true
    else {
      conversation.memberIds = conversation.memberIds.filter((member) => member !== id)
      delete conversation.memberSince[id]
    }
    touch(conversation)
  }
}

export function validateConversationArchive(
  state: AppState,
  id: string,
  expected: unknown,
  completingTaskId?: string,
): Conversation {
  const conversation = requireItem(state.conversations[id], '会话')
  revision(conversation, expected)
  if (state.bots[conversation.coordinatorId]?.webConversationId === id)
    throw new BotError(409, 'fixed-conversation', '固定私聊随 Bot 管理，请停用或删除对应 Bot')
  if (
    Object.values(state.tasks).some(
      (task) =>
        task.conversationId === id &&
        task.id !== completingTaskId &&
        ['queued', 'running', 'waiting', 'stopping'].includes(task.status),
    )
  )
    throw new BotError(409, 'active-tasks', '请先结束该会话的其他任务')
  return conversation
}

export function archiveConversation(state: AppState, id: string, expected: unknown) {
  const conversation = validateConversationArchive(state, id, expected)
  conversation.archived = true
  touch(conversation)
}

export function completeConfigurationAction(state: AppState, task: Task) {
  const action = task.completionAction
  if (!action || action.status !== 'pending') return
  if (task.status !== 'completed' || task.stopRequested) {
    action.status = 'cancelled'
    return
  }
  try {
    if (action.kind === 'delete-bot') deleteBot(state, action.targetId, action.revision)
    else archiveConversation(state, action.targetId, action.revision)
    action.status = 'completed'
  } catch (cause) {
    action.status = 'failed'
    action.error = cause instanceof BotError ? cause.message : '回复后的配置更改未完成'
  }
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
