import type { ChatState, ToolRun } from './types'

export function nestedTools(id: string, tools: ChatState['tools'], ancestors = new Set<string>()): ToolRun[] {
  if (ancestors.has(id)) return []
  const visited = new Set([...ancestors, id])
  return Object.values(tools)
    .filter((tool) => tool.parentToolCallId === id && !visited.has(tool.id))
    .map((tool) => ({ ...tool, children: nestedTools(tool.id, tools, visited) }))
}
