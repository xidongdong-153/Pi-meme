import type { PiMessage, PiModel, PiSessionEntries } from '@pi-meme/contracts/pi'
import type { TurnChunk } from './types'

type Model = Pick<PiModel, 'provider' | 'id'>
type ModelChange = Extract<TurnChunk, { type: 'model_change' }>

function sameModel(left: Model, right: Model) {
  return left.provider === right.provider && left.id === right.id
}

/** 只取当前分支中、可见对话开始后的实际模型切换。 */
export function modelChangesForConversation(
  sessionEntries: PiSessionEntries | undefined,
  messages: readonly PiMessage[],
): ModelChange[] {
  if (!sessionEntries?.leafId) return []
  const byId = new Map(sessionEntries.entries.map((entry) => [entry.id, entry]))
  const path: PiSessionEntries['entries'] = []
  const seen = new Set<string>()
  let entry = byId.get(sessionEntries.leafId)
  while (entry && !seen.has(entry.id)) {
    path.push(entry)
    seen.add(entry.id)
    entry = entry.parentId ? byId.get(entry.parentId) : undefined
  }
  path.reverse()

  const visibleIds = new Set(messages.flatMap((message) => (message.sourceEntry ? [message.sourceEntry.id] : [])))
  const firstVisibleIndex = path.findIndex((item) => visibleIds.has(item.id))
  const changes: ModelChange[] = []
  let previous: Model | undefined
  let hasSelection = false
  let hasConversation = false
  let pendingChange = false
  for (const [index, item] of path.entries()) {
    if (item.type === 'message') {
      if (item.role === 'user' || item.role === 'assistant') {
        hasConversation = true
        pendingChange = false
      }
      if (item.role === 'assistant' && !hasSelection && item.model) previous = item.model
      continue
    }
    if (item.type !== 'model_change' || !item.model) continue
    const next = item.model
    const timestamp = Date.parse(item.timestamp)
    if (
      hasConversation &&
      (firstVisibleIndex < 0 || index > firstVisibleIndex) &&
      (!previous || !sameModel(previous, next)) &&
      Number.isFinite(timestamp)
    ) {
      if (pendingChange) changes.pop()
      changes.push({ type: 'model_change', from: previous, to: next, timestamp, key: `model-change-${item.id}` })
      pendingChange = true
    }
    previous = next
    hasSelection = true
  }
  return changes
}
