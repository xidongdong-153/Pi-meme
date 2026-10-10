import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import type { DesktopSettings } from '@pi-meme/contracts/settings'
import type { PiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import { loadSubagentCatalog, subagentDefinitionDirectory } from '../server/catalog'
import { createSubagentExtension } from '../server/extension'

export async function create(context: {
  agentCore: typeof import('@earendil-works/pi-agent-core')
  sdk: typeof import('@earendil-works/pi-coding-agent')
  paths: PiRuntimePaths
  settings: DesktopSettings
}): Promise<InlineExtension[]> {
  if (!context.settings.subagentsEnabled) return []
  const catalog = await loadSubagentCatalog(
    subagentDefinitionDirectory(context.paths.agentDir),
    async () => context.sdk.parseFrontmatter,
  )
  const enabled = new Set(context.settings.enabledSubagents ?? [])
  const definitions = catalog.definitions.filter((definition) => enabled.has(definition.id))
  if (!definitions.length) return []
  return [createSubagentExtension(definitions, (options) => new context.agentCore.Agent(options))]
}
