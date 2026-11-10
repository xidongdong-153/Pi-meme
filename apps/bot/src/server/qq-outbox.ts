import type { AppState, Delivery, Message } from '../shared/types.js'

/** Called in the same durable commit as the public result. No network side effects. */
export function queueQqDeliveries(draft: AppState, message: Message): void {
  const conversation = draft.conversations[message.conversationId]
  if (
    conversation?.kind !== 'qq' ||
    message.source !== 'qq' ||
    message.role === 'user' ||
    !conversation.qqAppId ||
    !conversation.qqUserId
  )
    return
  const source = message.sourceMessageId ? draft.messages[message.sourceMessageId] : undefined
  const replyMessageId =
    draft.inboundIds[`qq-reply:${message.sourceMessageId ?? message.id}`] ?? source?.platformMessageId
  const parts = [...(message.content ? [undefined] : []), ...message.attachmentIds]
  for (const [partIndex, attachmentId] of parts.entries()) {
    const id = `qq-${message.id}-${partIndex}`
    if (draft.deliveries[id]) continue
    const used = Object.values(draft.deliveries).filter(
      (delivery) =>
        delivery.appId === conversation.qqAppId &&
        delivery.targetUserId === conversation.qqUserId &&
        replyMessageId &&
        delivery.replyMessageId === replyMessageId,
    ).length
    const blocked = !!replyMessageId && used >= 4
    const time = new Date().toISOString()
    const delivery: Delivery = {
      id,
      revision: 1,
      createdAt: time,
      updatedAt: time,
      messageId: message.id,
      conversationId: conversation.id,
      channel: 'qq',
      targetUserId: conversation.qqUserId,
      appId: conversation.qqAppId,
      status: blocked ? 'blocked' : 'pending',
      attempts: 0,
      replyMessageId,
      attachmentId,
      partIndex,
      replySequence: used + 1,
      error: blocked ? '同一被动消息已使用四条回复额度，其余结果保留在 Web' : undefined,
    }
    draft.deliveries[id] = delivery
  }
}
