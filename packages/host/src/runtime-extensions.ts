import { loadSubagentCatalog, subagentCatalogSnapshot } from '@pi-meme/subagents/server/catalog'
import { createSubagentExtension } from '@pi-meme/subagents/server/extension'
import type { DesktopSettings } from '@pi-meme/contracts/settings'
import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import { loadPiAgentCore, loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'

const loadFrontmatterParser = async () => (await loadPiSdk()).parseFrontmatter

export function selectEnabledSubagentDefinitions(
  settings: DesktopSettings,
  definitions: Awaited<ReturnType<typeof loadSubagentCatalog>>['definitions'],
) {
  if (!settings.subagentsEnabled) return []
  const enabled = new Set(settings.enabledSubagents ?? [])
  return definitions.filter((definition) => enabled.has(definition.id))
}

export async function optionalRuntimeExtensions(settings: DesktopSettings, directory: string) {
  const catalog = await loadSubagentCatalog(directory, loadFrontmatterParser)
  const definitions = selectEnabledSubagentDefinitions(settings, catalog.definitions)
  const agentCore = settings.subagentsEnabled && definitions.length ? await loadPiAgentCore() : undefined
  const extensions: InlineExtension[] = agentCore
    ? [createSubagentExtension(definitions, (options) => new agentCore.Agent(options))]
    : []
  return {
    extensions,
    catalog: subagentCatalogSnapshot(catalog, settings.enabledSubagents),
  }
}
