import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { SubagentCatalogSnapshot, SubagentDiagnostic } from '@pi-meme/contracts/settings'
import { parseSubagentDefinition, type SubagentDefinition, type SubagentFrontmatterParser } from './definition'

export const maxSubagentDefinitions = 16

export type SubagentCatalog = {
  directory: string
  definitions: SubagentDefinition[]
  diagnostics: SubagentDiagnostic[]
}

export function subagentDefinitionDirectory(agentDir: string) {
  return path.join(agentDir, 'subagents')
}

export async function loadSubagentCatalog(
  directory: string,
  loadFrontmatterParser: () => Promise<SubagentFrontmatterParser>,
): Promise<SubagentCatalog> {
  const diagnostics: SubagentDiagnostic[] = []
  let entries
  try {
    entries = (await readdir(directory, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.md'),
    )
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
      diagnostics.push({ path: directory, message: `无法扫描子 Agent 目录：${String(cause)}` })
    return { directory, definitions: [], diagnostics }
  }

  const definitions: SubagentDefinition[] = []
  let parseFrontmatter: SubagentFrontmatterParser | undefined
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const filename = path.join(directory, entry.name)
    try {
      parseFrontmatter ??= await loadFrontmatterParser()
      definitions.push(parseSubagentDefinition(filename, await readFile(filename, 'utf8'), parseFrontmatter))
    } catch (cause) {
      diagnostics.push({ path: filename, message: String(cause) })
    }
  }

  const ids = new Map<string, SubagentDefinition[]>()
  for (const definition of definitions) ids.set(definition.id, [...(ids.get(definition.id) ?? []), definition])
  const uniqueDefinitions = definitions.filter((definition) => {
    if ((ids.get(definition.id)?.length ?? 0) === 1) return true
    diagnostics.push({ path: definition.path, message: `子 Agent 名称重复：${definition.id}` })
    return false
  })
  for (const definition of uniqueDefinitions.slice(maxSubagentDefinitions))
    diagnostics.push({ path: definition.path, message: `超过最多加载 ${maxSubagentDefinitions} 个定义的限制` })

  return { directory, definitions: uniqueDefinitions.slice(0, maxSubagentDefinitions), diagnostics }
}

export function subagentCatalogSnapshot(catalog: SubagentCatalog, enabledIds: string[] = []): SubagentCatalogSnapshot {
  const enabled = new Set(enabledIds)
  return {
    directory: catalog.directory,
    agents: catalog.definitions.map(({ id, description, tools, maxTurns }) => ({
      id,
      description,
      tools: [...tools],
      maxTurns,
      enabled: enabled.has(id),
    })),
    diagnostics: catalog.diagnostics,
  }
}
