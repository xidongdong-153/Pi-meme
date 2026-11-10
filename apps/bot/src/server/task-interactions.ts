import { randomUUID } from 'node:crypto'
import type { AppState, Capability, Task, TaskInteraction, TaskResponse } from '../shared/types.js'
import type { BotStore } from './contracts.js'
import { BotError, requireItem, revision, text, touch } from './errors.js'
import { applyTaskProposal } from './domain-mutations.js'
import { botFields } from './bot-fields.js'

const capabilities: Capability[] = ['collaborate', 'hosts', 'images', 'web', 'schedules']
export function taskGrant(
  state: AppState,
  task: Task,
  capability: Capability,
  target?: { hostId?: string; projectId?: string; botId?: string },
) {
  return task.grants?.findLast(
    (grant) =>
      grant.capability === capability &&
      grant.botRevision === state.bots[task.botId]?.revision &&
      (!target ||
        Object.entries(target).every(([key, value]) => grant[key as 'hostId' | 'projectId' | 'botId'] === value)),
  )
}
export function hostAllowed(state: AppState, task: Task, hostId: string, projectId: string): boolean {
  const bot = state.bots[task.botId]
  if (!bot) return false
  if (taskGrant(state, task, 'hosts', { hostId, projectId })) return true
  if (!bot.capabilities.includes('hosts') || !task.config.capabilities.includes('hosts')) return false
  const contains = (config: Task['config']) =>
    config.hostIds.includes(hostId) ||
    config.hostGrants?.some((grant) => grant.hostId === hostId && grant.projectId === projectId) === true
  return contains(bot) && contains(task.config)
}
export function collaborationAllowed(state: AppState, task: Task, botId: string): boolean {
  const bot = state.bots[task.botId]
  const target = state.bots[botId]
  const conversation = state.conversations[task.conversationId]
  if (!bot?.enabled || !target?.enabled || !conversation || conversation.archived) return false
  return (
    (bot.capabilities.includes('collaborate') &&
      task.config.capabilities.includes('collaborate') &&
      bot.collaboratorIds.includes(botId) &&
      task.config.collaboratorIds.includes(botId)) ||
    !!taskGrant(state, task, 'collaborate', { botId }) ||
    (conversation.kind === 'group' &&
      conversation.collaborationEnabled === true &&
      conversation.memberIds.includes(task.botId) &&
      conversation.memberIds.includes(botId))
  )
}
export function assertTaskAuthorized(state: AppState, task: Task, capability?: Capability) {
  const conversation = requireItem(state.conversations[task.conversationId], '会话')
  if (conversation.archived) throw new BotError(403, 'forbidden', '来源会话已归档')
  const visited = new Set<string>()
  let current: Task | undefined = task
  while (current) {
    if (visited.has(current.id) || current.stopRequested || !['queued', 'running', 'waiting'].includes(current.status))
      throw new BotError(403, 'forbidden', '任务授权已停止')
    visited.add(current.id)
    const bot = requireItem(state.bots[current.botId], 'Bot')
    if (!bot.enabled) throw new BotError(403, 'forbidden', 'Bot已停用')
    if (current.publicReply && !conversation.memberIds.includes(current.botId))
      throw new BotError(403, 'forbidden', 'Bot已离开来源会话')
    if (
      current.id === task.id &&
      capability &&
      (!bot.capabilities.includes(capability) || !current.config.capabilities.includes(capability)) &&
      !taskGrant(state, current, capability) &&
      !(
        capability === 'collaborate' &&
        conversation.kind === 'group' &&
        conversation.collaborationEnabled &&
        conversation.memberIds.includes(current.botId)
      )
    )
      throw new BotError(403, 'forbidden', 'Bot能力授权已撤销')
    if (current.parentTaskId) {
      const parent: Task = requireItem(state.tasks[current.parentTaskId], '父任务')
      if (parent.botId !== current.botId && !collaborationAllowed(state, parent, current.botId))
        throw new BotError(403, 'forbidden', '父任务的协作授权已撤销')
      current = parent
    } else current = undefined
  }
}
export function validatePermissionTarget(
  state: AppState,
  task: Task,
  interaction: Pick<TaskInteraction, 'capability' | 'targetRefs'>,
) {
  const capability = interaction.capability
  if (!capability || !capabilities.includes(capability)) throw new BotError(400, 'invalid-input', '能力名称无效')
  const target = interaction.targetRefs
  if (capability === 'hosts') {
    if (target?.botId) throw new BotError(400, 'invalid-input', 'Host授权不接受Bot目标')
    const host = requireItem(state.hosts[target?.hostId ?? ''], 'Host')
    if (!target?.projectId || !host.projectIds.includes(target.projectId))
      throw new BotError(403, 'forbidden', '请求超出Host已授权项目范围')
  } else if (capability === 'collaborate') {
    if (target?.hostId || target?.projectId) throw new BotError(400, 'invalid-input', '协作授权不接受Host目标')
    const bot = requireItem(state.bots[target?.botId ?? ''], '协作Bot')
    if (!bot.enabled || bot.id === task.botId) throw new BotError(400, 'invalid-input', '协作目标无效')
  } else if (target && Object.values(target).some(Boolean))
    throw new BotError(400, 'invalid-input', '此能力不接受目标范围')
}

/** Each wait has a durable record keyed by the actual Durable tool call, including after a restart. */
export class TaskInteractions {
  constructor(
    private store: BotStore,
    private authorize: (state: AppState, task: Task) => void,
  ) {}
  async wait(
    taskId: string,
    callId: string,
    input: Omit<TaskInteraction, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'taskId' | 'toolCallId' | 'status'>,
    signal: AbortSignal,
  ) {
    const record = await this.store.update((state) => {
      const task = requireItem(state.tasks[taskId], '任务')
      this.authorize(state, task)
      const existing = task.interactions?.find((item) => item.toolCallId === callId)
      if (existing) {
        if (
          existing.kind !== input.kind ||
          existing.question !== input.question ||
          JSON.stringify(existing.options) !== JSON.stringify(input.options) ||
          existing.capability !== input.capability ||
          JSON.stringify(existing.targetRefs) !== JSON.stringify(input.targetRefs) ||
          JSON.stringify(existing.proposal) !== JSON.stringify(input.proposal)
        )
          throw new BotError(409, 'idempotency-conflict', '相同工具调用的交互内容不同')
        return existing
      }
      if ((task.interactions?.length ?? 0) >= 32) throw new BotError(409, 'limit-exceeded', '本轮交互已达上限')
      if (input.kind === 'permission') validatePermissionTarget(state, task, input)
      const now = new Date().toISOString()
      const item: TaskInteraction = {
        ...input,
        id: randomUUID(),
        revision: 1,
        createdAt: now,
        updatedAt: now,
        taskId,
        toolCallId: callId,
        status: 'pending',
      }
      ;(task.interactions ??= []).push(item)
      task.status = 'waiting'
      touch(task)
      return item
    })
    while (true) {
      signal.throwIfAborted()
      const state = this.store.read()
      const task = requireItem(state.tasks[taskId], '任务')
      this.authorize(state, task)
      const item = requireItem(
        task.interactions?.find((interaction) => interaction.id === record.id),
        '交互',
      )
      if (item.status === 'answered') return item
      if (item.status === 'cancelled') throw new BotError(409, 'interaction-cancelled', '交互已取消')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250)
        timer.unref()
      })
    }
  }
  async respond(taskId: string, input: TaskResponse, requestId: string): Promise<Task> {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !['interactionId', 'revision', 'decision', 'answer', 'scope'].includes(key))
    )
      throw new BotError(400, 'invalid-input', '交互响应字段无效')
    const interactionId = text(input.interactionId, '交互ID', 128)
    return this.store.update((state) => {
      const task = requireItem(state.tasks[taskId], '任务')
      const item = requireItem(
        task.interactions?.find((interaction) => interaction.id === interactionId),
        '交互',
      )
      const response: TaskResponse = { interactionId, revision: input.revision }
      if (item.kind === 'question') {
        if (input.decision !== undefined || input.scope !== undefined)
          throw new BotError(400, 'invalid-input', '问题只接受答案')
        if (Array.isArray(input.answer)) {
          if (!input.answer.length || input.answer.length > 16) throw new BotError(400, 'invalid-input', '答案数量无效')
          response.answer = input.answer.map((answer) => text(answer, '答案', 4000))
        } else response.answer = text(input.answer, '答案', 8000)
        if (
          item.options?.length &&
          (Array.isArray(response.answer) ? response.answer : [response.answer]).some(
            (answer) => !item.options?.some((option) => option.value === answer),
          )
        )
          throw new BotError(400, 'invalid-input', '答案不在可选范围')
      } else {
        if (!['approve', 'deny'].includes(input.decision ?? '') || input.answer !== undefined)
          throw new BotError(400, 'invalid-input', '请选择允许或拒绝')
        response.decision = input.decision
        if (item.kind === 'proposal' && input.scope !== undefined)
          throw new BotError(400, 'invalid-input', '草稿不接受授权范围')
        if (item.kind === 'permission') {
          if (input.scope !== undefined && !['task', 'bot'].includes(input.scope))
            throw new BotError(400, 'invalid-input', '授权范围无效')
          response.scope = input.scope ?? 'task'
        }
      }
      if (item.status === 'answered') {
        if (item.responseRequestId === requestId && JSON.stringify(item.response) === JSON.stringify(response))
          return task
        throw new BotError(409, 'interaction-consumed', '此交互已处理')
      }
      this.authorize(state, task)
      revision(item, input.revision)
      if (item.status !== 'pending') throw new BotError(409, 'interaction-consumed', '此交互已失效')
      if (item.kind === 'permission' && response.decision === 'approve') {
        validatePermissionTarget(state, task, item)
        let bot = requireItem(state.bots[task.botId], 'Bot')
        if (response.scope === 'bot') {
          bot = botFields(
            {
              capabilities: [...new Set([...bot.capabilities, item.capability!])],
              hostGrants:
                item.targetRefs?.hostId && item.targetRefs.projectId
                  ? [
                      ...(bot.hostGrants ?? []),
                      { hostId: item.targetRefs.hostId, projectId: item.targetRefs.projectId },
                    ]
                  : bot.hostGrants,
              collaboratorIds: item.targetRefs?.botId
                ? [...new Set([...bot.collaboratorIds, item.targetRefs.botId])]
                : bot.collaboratorIds,
            },
            state,
            bot,
          )
          touch(bot)
          state.bots[bot.id] = bot
        }
        ;(task.grants ??= []).push({
          capability: item.capability!,
          interactionId: item.id,
          grantedAt: new Date().toISOString(),
          botRevision: bot.revision,
          ...item.targetRefs,
        })
      }
      item.response = response
      item.responseRequestId = requestId
      item.status = 'answered'
      touch(item)
      task.status = task.interactions?.some((interaction) => interaction.status === 'pending') ? 'waiting' : 'running'
      touch(task)
      if (item.kind === 'proposal' && response.decision === 'approve') {
        if (!item.proposal) throw new BotError(409, 'interaction-conflict', '配置草稿已失效')
        applyTaskProposal(state, item.proposal, task.id, item.id)
      }
      return task
    })
  }
}
