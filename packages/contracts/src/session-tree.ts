import type { PiBranchEntry } from './pi'

/** 只依赖树结构的节点，运行时条目与 renderer 投影都可以传入。 */
export type SessionTreeNode = { id: string; parentId: string | null; timestamp: string }

function isUserNode(entry: SessionTreeNode): boolean {
  const candidate = entry as Partial<PiBranchEntry>
  return candidate.type === 'message' && candidate.role === 'user'
}

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

/**
 * 计算某个版本节点的分支终点（该子树里没有子节点的末端节点）。
 *
 * 选择顺序：
 * 1. 当前活动路径经过的末端节点，保证来回切换时不会漂移。
 * 2. 非用户消息末端节点中时间最新的，避免把 leaf 落回一条用户消息。
 * 3. 兜底取时间最新的末端节点。
 *
 * 版本切换要恢复该版本所属的完整后续对话，因此必须取到末端节点，
 * 不能在下一条用户消息处提前停下。
 */
export function branchEndpoint(
  entries: readonly SessionTreeNode[],
  leafId: string | null,
  rootId: string,
): SessionTreeNode | undefined {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const root = byId.get(rootId)
  if (!root) return undefined
  const children = new Map<string, SessionTreeNode[]>()
  for (const entry of entries) {
    if (!entry.parentId) continue
    const siblings = children.get(entry.parentId)
    if (siblings) siblings.push(entry)
    else children.set(entry.parentId, [entry])
  }
  const leaves: SessionTreeNode[] = []
  const walk = (node: SessionTreeNode) => {
    const next = children.get(node.id) ?? []
    if (!next.length) {
      leaves.push(node)
      return
    }
    for (const child of next) walk(child)
  }
  walk(root)
  if (!leaves.length) return root
  const active = activePathIds(entries, leafId)
  const activeLeaf = leaves.find((entry) => active.has(entry.id))
  if (activeLeaf) return activeLeaf
  const nonUser = leaves.filter((entry) => !isUserNode(entry))
  const pool = nonUser.length ? nonUser : leaves
  return [...pool].sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]
}
