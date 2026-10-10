export type SubagentFrontmatterParser = typeof import('@earendil-works/pi-coding-agent').parseFrontmatter

export const readonlySubagentTools = ['read', 'grep', 'find', 'ls'] as const
export const assignableSubagentTools = [...readonlySubagentTools, 'bash', 'edit', 'write'] as const
export type SubagentToolName = (typeof assignableSubagentTools)[number]

export const defaultSubagentMaxTurns = 8
export const maxSubagentMaxTurns = 80

export type SubagentDefinition = {
  id: string
  description: string
  prompt: string
  tools: SubagentToolName[]
  maxTurns: number
  path: string
}

function requiredText(value: unknown, key: string, maximumLength?: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少有效的 ${key}`)
  const text = value.trim()
  if (maximumLength !== undefined && text.length > maximumLength)
    throw new Error(`${key} 不能超过 ${maximumLength} 个字符`)
  return text
}

export function parseSubagentDefinition(
  path: string,
  source: string,
  parseFrontmatter: SubagentFrontmatterParser,
): SubagentDefinition {
  const { frontmatter, body } = parseFrontmatter(source)
  const id = requiredText(frontmatter.name, 'name', 64)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error('name 只能使用小写字母、数字和连字符')
  const description = requiredText(frontmatter.description, 'description', 160)
  const prompt = requiredText(body, 'Markdown 正文')

  let tools: SubagentToolName[] = [...readonlySubagentTools]
  if (frontmatter.tools !== undefined) {
    if (!Array.isArray(frontmatter.tools) || frontmatter.tools.some((tool) => typeof tool !== 'string'))
      throw new Error('tools 必须是工具名称数组')
    const unique = [...new Set(frontmatter.tools)]
    const invalid = unique.find((tool) => !assignableSubagentTools.includes(tool as SubagentToolName))
    if (invalid) throw new Error(`不支持的子 Agent 工具：${invalid}`)
    tools = unique as SubagentToolName[]
  }

  const maxTurns = frontmatter.maxTurns ?? defaultSubagentMaxTurns
  if (!Number.isInteger(maxTurns) || typeof maxTurns !== 'number' || maxTurns < 1 || maxTurns > maxSubagentMaxTurns)
    throw new Error(`maxTurns 必须是 1 到 ${maxSubagentMaxTurns} 之间的整数`)

  return { id, description, prompt, tools, maxTurns, path }
}
