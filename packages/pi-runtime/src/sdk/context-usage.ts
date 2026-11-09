import { getCurrentSystemMessage } from '@earendil-works/pi-ai'
import type { SessionEntry, SessionProjection } from '@earendil-works/pi-coding-agent'
import type { PiSessionStats } from '@pi-meme/contracts/pi'
import type { PiSdk } from './load'

/** 压缩前保留的 assistant usage 不能代表压缩后的上下文。 */
export function withCompactionContextUsage(
  stats: PiSessionStats,
  branch: SessionEntry[],
  sdk: PiSdk,
  projection?: SessionProjection,
): PiSessionStats {
  const index = branch.findLastIndex((entry) => entry.type === 'compaction')
  if (index < 0) return stats
  const compaction = branch[index]
  const context = projection ?? sdk.buildSessionProjection(branch)
  const measured = new Set(
    context.entries.flatMap((entry) =>
      entry.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.stopReason !== 'aborted' &&
          message.stopReason !== 'error' &&
          sdk.calculateContextTokens(message.usage) > 0,
      )
        ? [entry.sourceEntry.id]
        : [],
    ),
  )
  const hasUsage = branch.slice(index + 1).some((entry) => measured.has(entry.id))
  const usage = stats.contextUsage ?? { tokens: null, contextWindow: 0, percent: null }
  if (hasUsage) return { ...stats, contextUsage: { ...usage, compactionId: compaction.id, estimated: undefined } }

  const system = getCurrentSystemMessage(context.messages)
  const tokens = context.messages.reduce(
    (total, message) => total + (message.role === 'system' ? 0 : sdk.estimateTokens(message)),
    system ? sdk.estimateTokens(system) : 0,
  )
  return {
    ...stats,
    contextUsage: {
      tokens,
      contextWindow: usage.contextWindow,
      percent: usage.contextWindow > 0 ? (tokens / usage.contextWindow) * 100 : null,
      compactionId: compaction.id,
      estimated: true,
    },
  }
}
