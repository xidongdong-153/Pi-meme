import type { PiBranchEntry, PiSessionEntries } from '@pi-meme/contracts/pi'
import { activePathIds } from '@pi-meme/contracts/session-tree'

export type FilterMode = 'default' | 'all' | 'user' | 'no-tools'

export type Gutter = { position: number; show: boolean }

export type SessionTreeRow = {
  entry: PiBranchEntry
  indent: number
  showConnector: boolean
  isLast: boolean
  gutters: Gutter[]
  childCount: number
  foldable: boolean
  folded: boolean
}

/** 默认视图中隐藏的记账类条目，对齐 Pi TUI 的 tree-selector。 */
const BOOKKEEPING_TYPES = new Set([
  'label',
  'context_edit',
  'custom',
  'model_change',
  'thinking_level_change',
  'session_info',
])

export function isUserEntry(entry: PiBranchEntry): boolean {
  return entry.type === 'message' && entry.role === 'user'
}

function isToolEntry(entry: PiBranchEntry): boolean {
  return entry.type === 'message' && (entry.role === 'toolResult' || entry.role === 'bashExecution')
}

function passesFilter(entry: PiBranchEntry, mode: FilterMode, isLeaf: boolean): boolean {
  if (entry.type === 'usage') return false
  if (mode === 'all') return true
  if (mode === 'user') return isUserEntry(entry)
  // 助手消息只有工具调用没有正文时默认不单独占行；当前 leaf 例外，避免活动位置消失。
  if (entry.type === 'message' && entry.role === 'assistant' && !entry.preview && !isLeaf) return false
  if (mode === 'no-tools') return !isToolEntry(entry)
  return !BOOKKEEPING_TYPES.has(entry.type)
}

function matchesSearch(entry: PiBranchEntry, query: string): boolean {
  const haystack = `${entry.role ?? ''} ${entry.type} ${entry.preview ?? ''}`.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token))
}

/**
 * 把条目树摊平成可渲染的行。
 *
 * 过滤后隐藏的中间节点会被跳过，可见子节点挂到最近可见祖先上，和 Pi TUI 的 tree-selector 一致。
 * 缩进规则同样对齐 TUI：单子节点链保持当前缩进，只在分支点和分支后的第一代 +1。
 * 长会话大多是单链，若按树深度逐层缩进，深层的行会把正文顶出可视区。
 */
export function buildSessionTreeRows(
  data: PiSessionEntries | undefined,
  options: { filterMode: FilterMode; searchQuery: string; foldedIds: ReadonlySet<string> },
) {
  const { filterMode, searchQuery, foldedIds } = options
  const entries = data?.entries ?? []
  const leafId = data?.leafId ?? null
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const childrenMap = new Map<string | null, PiBranchEntry[]>()
  for (const entry of entries) {
    const key = entry.parentId ?? null
    const list = childrenMap.get(key)
    if (list) list.push(entry)
    else childrenMap.set(key, [entry])
  }
  for (const list of childrenMap.values()) list.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const activeIds = activePathIds(entries, leafId)

  const visibleIds = new Set(
    entries
      .filter(
        (entry) =>
          passesFilter(entry, filterMode, entry.id === leafId) && (!searchQuery || matchesSearch(entry, searchQuery)),
      )
      .map((entry) => entry.id),
  )
  const visibleChildrenMap = new Map<string | null, PiBranchEntry[]>()
  const visibleParent = new Map<string, string | null>()
  for (const entry of entries) {
    if (!visibleIds.has(entry.id)) continue
    let parentId = entry.parentId
    while (parentId && !visibleIds.has(parentId)) parentId = byId.get(parentId)?.parentId ?? null
    visibleParent.set(entry.id, parentId)
    const list = visibleChildrenMap.get(parentId)
    if (list) list.push(entry)
    else visibleChildrenMap.set(parentId, [entry])
  }
  const visibleChildren = (id: string) => visibleChildrenMap.get(id) ?? []

  const rows: SessionTreeRow[] = []
  type Frame = {
    entry: PiBranchEntry
    indent: number
    justBranched: boolean
    showConnector: boolean
    isLast: boolean
    gutters: Gutter[]
    parentChildren: number
  }
  const roots = visibleChildrenMap.get(null) ?? []
  const stack: Frame[] = []
  for (let index = roots.length - 1; index >= 0; index--) {
    stack.push({
      entry: roots[index],
      indent: 0,
      justBranched: false,
      showConnector: false,
      isLast: index === roots.length - 1,
      gutters: [],
      parentChildren: roots.length,
    })
  }
  while (stack.length) {
    const frame = stack.pop()
    if (!frame) break
    const children = visibleChildren(frame.entry.id)
    const parentId = visibleParent.get(frame.entry.id) ?? null
    const siblings = parentId === null ? roots.length : visibleChildren(parentId).length
    const foldable = children.length > 0 && (parentId === null || siblings > 1)
    const folded = foldable && foldedIds.has(frame.entry.id)
    rows.push({
      entry: frame.entry,
      indent: frame.indent,
      showConnector: frame.showConnector,
      isLast: frame.isLast,
      gutters: frame.gutters,
      childCount: children.length,
      foldable,
      folded,
    })
    if (folded) continue
    const multipleChildren = children.length > 1
    const childIndent = multipleChildren
      ? frame.indent + 1
      : frame.justBranched && frame.indent > 0
        ? frame.indent + 1
        : frame.indent
    const childGutters = frame.showConnector
      ? [...frame.gutters, { position: Math.max(0, frame.indent - 1), show: !frame.isLast }]
      : frame.gutters
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({
        entry: children[index],
        indent: childIndent,
        justBranched: multipleChildren,
        showConnector: multipleChildren,
        isLast: index === children.length - 1,
        gutters: childGutters,
        parentChildren: children.length,
      })
    }
  }

  let branchCount = 0
  for (const [parentId, list] of childrenMap) {
    if (parentId !== null && list.length > 1) branchCount++
  }

  return { leafId, byId, childrenMap, activeIds, rows, branchCount, entryCount: entries.length }
}
