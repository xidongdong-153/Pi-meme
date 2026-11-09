import { randomUUID } from 'node:crypto'
import type { AppState, Bot, Conversation } from '../shared/types.js'
import { requireItem, touch } from './errors.js'

function belongsToBot(conversation: Conversation | undefined, bot: Bot): conversation is Conversation {
  return (
    conversation?.kind === 'direct' &&
    conversation.coordinatorId === bot.id &&
    conversation.memberIds.length === 1 &&
    conversation.memberIds[0] === bot.id
  )
}

export function fixedBotConversation(state: AppState, bot: Bot): Conversation | undefined {
  const linked = bot.webConversationId ? state.conversations[bot.webConversationId] : undefined
  if (belongsToBot(linked, bot)) return linked
  return Object.values(state.conversations)
    .filter((conversation) => belongsToBot(conversation, bot))
    .sort(
      (left, right) =>
        Number(left.archived) - Number(right.archived) ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )[0]
}

// Call only inside store.update: selecting and creating share the Durable write transaction.
export function ensureBotConversation(state: AppState, botId: string): Conversation {
  const bot = requireItem(state.bots[botId], 'Bot')
  let conversation = fixedBotConversation(state, bot)
  if (!conversation) {
    const now = new Date().toISOString()
    conversation = {
      id: randomUUID(),
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
  } else if (conversation.archived || conversation.name !== bot.name) {
    conversation.archived = false
    conversation.name = bot.name
    touch(conversation)
  }
  if (bot.webConversationId !== conversation.id) {
    bot.webConversationId = conversation.id
    touch(bot)
  }
  return conversation
}
