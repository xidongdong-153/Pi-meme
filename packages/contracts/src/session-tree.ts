/** 只依赖树结构的节点，运行时条目与 renderer 投影都可以传入。 */
export type SessionTreeNode = { id: string; parentId: string | null; timestamp: string }

/** 从 leafId 回溯到根，返回活动路径上的节点 id。 */
export function activePathIds(entries: readonly SessionTreeNode[], leafId: string | null): Set<string> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const ids = new Set<string>()
  let current = leafId ? byId.get(leafId) : undefined
  while (current) {
    ids.add(current.id)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return ids
}
