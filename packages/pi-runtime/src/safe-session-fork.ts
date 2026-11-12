import type { PiSessionEntry } from '@pi-meme/contracts/pi'
import type { SystemMessage } from '@earendil-works/pi-ai'
import { sessionThinkingEntry, stripUltraSystemMessage } from './session-thinking'

/** 只复制当前分支；未闭合的 assistant 工具批次及其后条目整体排除。 */
export function safeBranchLeaf(entries: PiSessionEntry[], leafId: string | null): string | null {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const branch: PiSessionEntry[] = []
  const seen = new Set<string>()
  let entry = leafId ? byId.get(leafId) : undefined
  while (entry && !seen.has(entry.id)) {
    branch.push(entry)
    seen.add(entry.id)
    entry = entry.parentId ? byId.get(entry.parentId) : undefined
  }
  branch.reverse()
  let safe: string | null = null
  const pending = new Set<string>()
  for (const current of branch) {
    if (current.type === 'message') {
      if (current.message.role === 'user' && pending.size)
        throw new Error('最新用户消息位于未闭合工具组之后，无法安全继承历史；请使用 fork_turns=none')
      if (current.message.role === 'assistant') {
        for (const content of current.message.content) if (content.type === 'toolCall') pending.add(content.id)
      } else if (current.message.role === 'toolResult') pending.delete(current.message.toolCallId)
    }
    if (!pending.size) safe = current.id
  }
  return safe
}

/** 子身份只继承原生档位；普通用户分叉不调用此投影。原生 entry IDs 保持不变。 */
export function stripUltraFromForkEntries(entries: readonly PiSessionEntry[]): PiSessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const removed = new Set(
    entries
      .filter((entry) => entry.type === 'custom' && entry.customType === sessionThinkingEntry)
      .map((entry) => entry.id),
  )
  // 指向被删除策略节点的 label/context edit 也不能留下孤立引用。
  let changed = true
  while (changed) {
    changed = false
    for (const entry of entries)
      if (
        (entry.type === 'label' || entry.type === 'context_edit') &&
        removed.has(entry.targetId) &&
        !removed.has(entry.id)
      ) {
        removed.add(entry.id)
        changed = true
      }
  }
  const retainedParent = (id: string | null): string | null => {
    const seen = new Set<string>()
    while (id && removed.has(id)) {
      if (seen.has(id)) throw new Error('继承会话的策略条目存在循环，无法安全分叉')
      seen.add(id)
      id = byId.get(id)?.parentId ?? null
    }
    return id
  }
  const firstKept = (entry: Extract<PiSessionEntry, { type: 'compaction' }>) => {
    if (!removed.has(entry.firstKeptEntryId)) return entry.firstKeptEntryId
    const branch: PiSessionEntry[] = []
    const seen = new Set<string>()
    let current: PiSessionEntry | undefined = entry
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      branch.push(current)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    branch.reverse()
    const start = branch.findIndex((value) => value.id === entry.firstKeptEntryId)
    return start >= 0
      ? (branch.slice(start + 1).find((value) => !removed.has(value.id))?.id ?? entry.id)
      : (retainedParent(entry.firstKeptEntryId) ?? entry.id)
  }
  return entries
    .filter((entry) => !removed.has(entry.id))
    .map((entry) => {
      let value = entry
      const parentId = retainedParent(entry.parentId)
      if (parentId !== entry.parentId) value = { ...value, parentId }
      if (value.type === 'message') {
        const message = stripUltraSystemMessage(value.message)
        if (message !== value.message) value = { ...value, message }
      }
      if (entry.type === 'compaction' && value.type === 'compaction') {
        const firstKeptEntryId = firstKept(entry)
        if (firstKeptEntryId !== value.firstKeptEntryId) value = { ...value, firstKeptEntryId }
      }
      if (value.type === 'branch_summary' && removed.has(value.fromId))
        value = { ...value, fromId: retainedParent(value.fromId) ?? value.id }
      const stored = value as PiSessionEntry & { systemMessage?: SystemMessage }
      if (stored.systemMessage) {
        const systemMessage = stripUltraSystemMessage(stored.systemMessage)
        if (systemMessage !== stored.systemMessage) value = { ...value, systemMessage } as PiSessionEntry
      }
      return value
    })
}
