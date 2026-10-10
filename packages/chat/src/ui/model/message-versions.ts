import type { PiBranchEntry, PiMessage, PiSessionEntries } from '@pi-meme/contracts/pi'
import { activePathIds, branchEndpoint } from '@pi-meme/contracts/session-tree'

export type MessageVersion = { timestamp: number; targetEntryId: string; selected: boolean }

function isUserEntry(entry: PiBranchEntry): boolean {
  return entry.type === 'message' && entry.role === 'user' && typeof entry.messageTimestamp === 'number'
}

export function messageVersions(data: PiSessionEntries | undefined, message: PiMessage): MessageVersion[] {
  if (!data || message.role !== 'user' || typeof message.timestamp !== 'number') return []
  const anchor = data.entries.find((entry) => isUserEntry(entry) && entry.messageTimestamp === message.timestamp)
  if (!anchor) return []
  const versions = data.entries
    .filter((entry) => isUserEntry(entry) && entry.parentId === anchor.parentId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  if (versions.length < 2) return []
  // 与运行时使用同一套分支终点规则：版本切换恢复到该版本所属的完整后续对话。
  const active = activePathIds(data.entries, data.leafId)
  return versions.map((version) => {
    const endpoint = branchEndpoint(data.entries, data.leafId, version.id)
    const targetEntryId = endpoint?.id ?? version.id
    return {
      timestamp: version.messageTimestamp!,
      targetEntryId,
      selected: active.has(targetEntryId),
    }
  })
}
