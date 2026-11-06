import type { ChatState, ToolRun } from './types'

const emptyChildren: ToolRun[] = []
const indexes = new WeakMap<ChatState['tools'], ReturnType<typeof buildIndex>>()

function buildIndex(tools: ChatState['tools']) {
  const values = Object.values(tools)
  const children = new Map<string, ToolRun[]>()
  for (const tool of values) {
    if (tool.parentToolCallId === undefined) continue
    const siblings = children.get(tool.parentToolCallId)
    if (siblings) siblings.push(tool)
    else children.set(tool.parentToolCallId, [tool])
  }
  return { values, children, roots: new Map<string, ToolRun[]>() }
}

/** 保留工具表的枚举顺序；同一不可变工具快照只建立一次父子索引。 */
export function toolTreeIndex(tools: ChatState['tools']) {
  let index = indexes.get(tools)
  if (!index) {
    index = buildIndex(tools)
    indexes.set(tools, index)
  }
  return index
}

export function nestedTools(id: string, tools: ChatState['tools'], ancestors = new Set<string>()): ToolRun[] {
  if (ancestors.has(id)) return emptyChildren
  const index = toolTreeIndex(tools)
  if (!ancestors.size) {
    const cached = index.roots.get(id)
    if (cached) return cached
  }
  const visit = (parentId: string, visited: Set<string>): ToolRun[] => {
    const children = index.children.get(parentId)
    if (!children?.length) return emptyChildren
    visited.add(parentId)
    const result: ToolRun[] = []
    for (const tool of children) {
      if (!visited.has(tool.id)) result.push({ ...tool, children: visit(tool.id, visited) })
    }
    visited.delete(parentId)
    return result
  }
  const result = visit(id, new Set(ancestors))
  if (!ancestors.size) index.roots.set(id, result)
  return result
}
