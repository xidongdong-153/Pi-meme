import { randomUUID } from 'node:crypto'
import type { AppState, Task, TaskInteraction, TaskResponse } from '../shared/types.js'
import type { BotStore, QqInteractionSource } from './contracts.js'
import { BotError, requireItem, revision, text, touch } from './errors.js'
import { queueQqDeliveries } from './qq-outbox.js'
import { isCurrentQqTarget } from './qq-identity.js'

export function collaborationAllowed(state: AppState, task: Task, botId: string): boolean {
  const bot = state.bots[task.botId]
  const target = state.bots[botId]
  const conversation = state.conversations[task.conversationId]
  return Boolean(
    bot &&
    (bot.enabled || task.finishOnDisable) &&
    target?.enabled &&
    botId !== bot.id &&
    conversation &&
    !conversation.archived &&
    (conversation.kind !== 'group' || conversation.collaborationEnabled !== false),
  )
}

export function assertTaskAuthorized(state: AppState, task: Task) {
  const conversation = requireItem(state.conversations[task.conversationId], '会话')
  if (conversation.archived) throw new BotError(403, 'forbidden', '来源会话已归档')
  const visited = new Set<string>()
  let current: Task | undefined = task
  while (current) {
    if (visited.has(current.id) || current.stopRequested || !['queued', 'running', 'waiting'].includes(current.status))
      throw new BotError(403, 'forbidden', '任务已停止')
    visited.add(current.id)
    const bot = requireItem(state.bots[current.botId], 'Bot')
    if (!bot.enabled && !current.finishOnDisable) throw new BotError(403, 'forbidden', 'Bot已停用')
    if (current.publicReply && !conversation.memberIds.includes(current.botId))
      throw new BotError(403, 'forbidden', 'Bot已离开来源会话')
    current = current.parentTaskId ? requireItem(state.tasks[current.parentTaskId], '父任务') : undefined
  }
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
          JSON.stringify(existing.options) !== JSON.stringify(input.options)
        )
          throw new BotError(409, 'idempotency-conflict', '相同工具调用的交互内容不同')
        return existing
      }
      if ((task.interactions?.length ?? 0) >= 32) throw new BotError(409, 'limit-exceeded', '本轮交互已达上限')
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
      const conversation = state.conversations[task.conversationId]
      if (task.notification === 'qq' && task.qqTarget) {
        const sourceTask = task.mode === 'steer' && task.parentTaskId ? state.tasks[task.parentTaskId] : task
        const messageId = randomUUID()
        const choices = item.options?.map((option, index) => `${index + 1}. ${option.label}`).join('\n')
        state.messages[messageId] = {
          id: messageId,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          conversationId: conversation.id,
          sequence: ++conversation.sequence,
          role: 'system',
          authorName: task.config.name,
          botId: task.botId,
          taskId,
          interactionId: item.id,
          sourceMessageId: sourceTask.sourceMessageId,
          content: [item.question, choices, item.kind === 'confirmation' ? '回复“确认”或“取消”' : '直接回复答案']
            .filter(Boolean)
            .join('\n'),
          attachmentIds: [],
          source: 'qq',
          qqTarget: task.qqTarget,
        }
        queueQqDeliveries(state, state.messages[messageId])
        touch(conversation)
      }
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
  async respond(
    taskId: string,
    input: TaskResponse,
    requestId: string,
    qqIdentity?: QqInteractionSource,
  ): Promise<Task> {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !['interactionId', 'revision', 'decision', 'answer'].includes(key))
    )
      throw new BotError(400, 'invalid-input', '交互响应字段无效')
    const interactionId = text(input.interactionId, '交互ID', 128)
    return this.store.update((state) => {
      const task = requireItem(state.tasks[taskId], '任务')
      if (qqIdentity) {
        const conversation = requireItem(state.conversations[task.conversationId], '会话')
        if (
          !isCurrentQqTarget(state, qqIdentity) ||
          conversation.kind !== 'direct' ||
          state.bots[conversation.coordinatorId]?.conversationId !== conversation.id
        )
          throw new BotError(403, 'forbidden', 'QQ 账号绑定已经改变')
      }
      const item = requireItem(
        task.interactions?.find((interaction) => interaction.id === interactionId),
        '交互',
      )
      const response: TaskResponse = { interactionId, revision: input.revision }
      if (item.kind === 'question') {
        if (input.decision !== undefined) throw new BotError(400, 'invalid-input', '问题只接受答案')
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
      }
      if (item.status === 'answered') {
        if (item.responseRequestId === requestId && JSON.stringify(item.response) === JSON.stringify(response))
          return task
        throw new BotError(409, 'interaction-consumed', '此交互已处理')
      }
      this.authorize(state, task)
      revision(item, input.revision)
      if (item.status !== 'pending') throw new BotError(409, 'interaction-consumed', '此交互已失效')
      item.response = response
      item.responseRequestId = requestId
      item.status = 'answered'
      if (qqIdentity) {
        const sourceTask = task.mode === 'steer' && task.parentTaskId ? state.tasks[task.parentTaskId] : task
        state.inboundIds[qqIdentity.inboundKey] = item.id
        state.inboundIds[`qq-reply:${sourceTask.sourceMessageId}`] = qqIdentity.platformMessageId
        const conversation = state.conversations[task.conversationId]
        const messageId = randomUUID()
        const now = new Date().toISOString()
        state.messages[messageId] = {
          id: messageId,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          conversationId: conversation.id,
          sequence: ++conversation.sequence,
          role: 'user',
          authorName: '你',
          content: response.decision
            ? response.decision === 'approve'
              ? '确认'
              : '取消'
            : Array.isArray(response.answer)
              ? response.answer.join('\n')
              : response.answer!,
          attachmentIds: [],
          recipientIds: [conversation.coordinatorId],
          source: 'qq',
          sourceMessageId: sourceTask.sourceMessageId,
          platformMessageId: qqIdentity.platformMessageId,
          qqTarget: { appId: qqIdentity.appId, userId: qqIdentity.userId, bindingId: qqIdentity.bindingId },
        }
        touch(conversation)
      }
      touch(item)
      task.status = task.interactions?.some((interaction) => interaction.status === 'pending') ? 'waiting' : 'running'
      touch(task)
      return task
    })
  }
}
