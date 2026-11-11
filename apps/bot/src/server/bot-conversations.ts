import type { AppState, Conversation } from '../shared/types.js'
import { BotError, requireItem, touch } from './errors.js'

// Call only inside store.update: selecting and creating share the Durable write transaction.
export function ensureBotConversation(state: AppState, botId: string): Conversation {
  const bot = requireItem(state.bots[botId], 'Bot')
  let conversation = state.conversations[bot.conversationId]
  if (!conversation) {
    const now = new Date().toISOString()
    conversation = {
      id: bot.conversationId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      name: bot.name,
      kind: 'direct',
      memberIds: [bot.id],
      coordinatorId: bot.id,
      memberSince: { [bot.id]: 0 },
      pinned: false,
      archived: false,
      sequence: 0,
    }
    state.conversations[conversation.id] = conversation
  } else {
    if (
      conversation.kind !== 'direct' ||
      conversation.coordinatorId !== bot.id ||
      conversation.memberIds.length !== 1 ||
      conversation.memberIds[0] !== bot.id
    )
      throw new BotError(409, 'invalid-conversation', 'Bot 主对话关联无效')
    if (conversation.archived || conversation.name !== bot.name) {
      conversation.archived = false
      conversation.name = bot.name
      touch(conversation)
    }
  }
  return conversation
}
