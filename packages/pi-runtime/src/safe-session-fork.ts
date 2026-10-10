import type { PiSessionEntry } from '@pi-meme/contracts/pi'

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
