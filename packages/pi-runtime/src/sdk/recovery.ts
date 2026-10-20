import { isRetryableAssistantError } from '@earendil-works/pi-ai'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { TaskMode } from '@pi-meme/contracts/plan'

export const recoveryEntryType = 'pi-meme-recovery'
export const recoveryMessage =
  'Continue the unfinished task after the connection interruption. Reuse the existing context and tool results. Do not repeat completed operations; verify the current state before retrying any operation whose outcome is uncertain.'

type FailureEntry = Extract<SessionEntry, { type: 'message' }>

/** 只恢复当前分支尾部的连接失败；成功消息和工具结果均是不可跨越的边界。 */
export function findSessionRecovery(entries: readonly SessionEntry[], leafId: string | null) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const branch: SessionEntry[] = []
  for (
    let entry = leafId ? byId.get(leafId) : undefined;
    entry;
    entry = entry.parentId ? byId.get(entry.parentId) : undefined
  )
    branch.push(entry)
  const edits = new Map<string, boolean>()
  for (const entry of branch)
    if (entry.type === 'context_edit' && !edits.has(entry.targetId))
      edits.set(entry.targetId, entry.replacement === null)

  const failures: FailureEntry[] = []
  let latest: FailureEntry | undefined
  for (const entry of branch) {
    if (entry.type === 'custom_message' || entry.type === 'compaction' || entry.type === 'branch_summary') {
      if (!edits.get(entry.id)) break
      continue
    }
    if (entry.type !== 'message' || entry.message.role === 'system') continue
    if (entry.message.role === 'assistant' && entry.message.stopReason === 'error') {
      failures.push(entry)
      if (!latest && !edits.get(entry.id)) {
        if (!isRetryableAssistantError(entry.message)) return undefined
        latest = entry
      }
    } else if (!edits.get(entry.id)) break
  }
  if (!latest) return undefined
  const metadata = branch.find(
    (entry) =>
      entry.type === 'custom' &&
      entry.customType === recoveryEntryType &&
      (entry.data as { entryId?: unknown } | undefined)?.entryId === latest.id,
  )
  const mode: TaskMode =
    metadata?.type === 'custom' && (metadata.data as { mode?: unknown } | undefined)?.mode === 'plan'
      ? 'plan'
      : 'default'
  return { entryId: latest.id, mode, failures }
}
