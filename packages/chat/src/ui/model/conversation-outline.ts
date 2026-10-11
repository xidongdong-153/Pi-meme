import { messageText } from './message-text'
import type { ConversationOutlineEntry, TurnChunk } from './types'

function truncate(text: string, limit: number): string {
  const characters = Array.from(text)
  return characters.length <= limit
    ? text
    : `${characters
        .slice(0, limit - 1)
        .join('')
        .trimEnd()}…`
}

function plainPreview(text: string): string {
  return text
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function conversationOutline(turns: readonly TurnChunk[]): ConversationOutlineEntry[] {
  const entries: ConversationOutlineEntry[] = []
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex]!
    if (turn.type !== 'user') continue

    const title = messageText(turn.message).replace(/\s+/g, ' ').trim()
    const hasUserImage =
      'content' in turn.message &&
      Array.isArray(turn.message.content) &&
      turn.message.content.some((part) => part.type === 'image')
    const texts: string[] = []
    let errorMessage = ''
    let hasImages = false
    let isLive = false
    for (let nextIndex = turnIndex + 1; nextIndex < turns.length; nextIndex++) {
      const reply = turns[nextIndex]!
      if (reply.type === 'user') break
      if (reply.type !== 'assistant_turn') continue
      if (reply.finalText.trim()) texts.push(reply.finalText)
      if (reply.errorMessage?.trim()) errorMessage = reply.errorMessage
      hasImages ||= reply.images.length > 0
      isLive ||= reply.isLive
    }

    const preview =
      plainPreview(texts.join('\n\n')) ||
      plainPreview(errorMessage) ||
      (hasImages ? '图片回复' : isLive ? '正在回复…' : '暂无回复')
    entries.push({
      key: turn.key,
      turnIndex,
      title: truncate(title || (hasUserImage ? '图片消息' : '用户消息'), 100),
      preview: truncate(preview, 240),
    })
  }
  return entries
}
