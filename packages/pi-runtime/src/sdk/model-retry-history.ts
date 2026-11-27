import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { PiMessage, PiModelRequestFailure } from '@pi-meme/contracts/pi'

export const modelRetryHistoryEntry = 'pi-meme-model-retry'

/** 把自动重试的诊断附到同一分页中的原生消息。模型上下文仍由 Pi 的省略编辑决定。 */
export function withModelRetryFailures(messages: PiMessage[], branch: readonly SessionEntry[]): PiMessage[] {
  if (!branch.some((entry) => entry.type === 'custom' && entry.customType === modelRetryHistoryEntry)) return messages

  const omissions = new Map<string, string>()
  const retries = new Map<string, string>()
  for (const entry of branch) {
    if (entry.type === 'context_edit') {
      if (entry.replacement === null) omissions.set(entry.targetId, entry.id)
      else omissions.delete(entry.targetId)
    } else if (entry.type === 'custom' && entry.customType === modelRetryHistoryEntry) {
      const data = entry.data as { entryId?: unknown; omissionId?: unknown; clearedEntryIds?: unknown } | undefined
      if (typeof data?.entryId === 'string' && typeof data.omissionId === 'string') {
        retries.set(data.entryId, data.omissionId)
      } else if (Array.isArray(data?.clearedEntryIds)) {
        for (const id of data.clearedEntryIds) if (typeof id === 'string') retries.delete(id)
      }
    }
  }
  if (!retries.size) return messages

  const anchors = new Map<string, number>()
  for (const [index, message] of messages.entries()) {
    if (message.sourceEntry && (message.role === 'user' || message.role === 'assistant'))
      anchors.set(message.sourceEntry.id, index)
  }
  if (!anchors.size) {
    // 仅续跑控制消息的分支仍需要一个分页锚点。
    for (const [index, message] of messages.entries())
      if (message.role === 'custom' && message.sourceEntry) anchors.set(message.sourceEntry.id, index)
  }
  if (!anchors.size) return messages

  const failuresByAnchor = new Map<number, PiModelRequestFailure[]>()
  let anchor: number | undefined
  let leadingFailures: PiModelRequestFailure[] = []
  for (const entry of branch) {
    const index = anchors.get(entry.id)
    if (index !== undefined) {
      anchor = index
      if (leadingFailures.length) {
        failuresByAnchor.set(index, leadingFailures)
        leadingFailures = []
      }
    }
    const omissionId = retries.get(entry.id)
    if (
      !omissionId ||
      omissionId !== omissions.get(entry.id) ||
      entry.type !== 'message' ||
      entry.message.role !== 'assistant' ||
      entry.message.stopReason !== 'error'
    )
      continue
    const failure: PiModelRequestFailure = {
      entryId: entry.id,
      timestamp: entry.message.timestamp,
      errorMessage: entry.message.errorMessage?.trim() || '未知错误',
    }
    if (anchor === undefined) leadingFailures.push(failure)
    else {
      const failures = failuresByAnchor.get(anchor)
      if (failures) failures.push(failure)
      else failuresByAnchor.set(anchor, [failure])
    }
  }
  if (!failuresByAnchor.size) return messages
  return messages.map((message, index) => {
    const retryFailures = failuresByAnchor.get(index)
    return retryFailures ? { ...message, retryFailures } : message
  })
}
