import { loadSubagentCatalog, subagentCatalogSnapshot } from '@pi-meme/subagents/server/catalog'
import type { DesktopSettings } from '@pi-meme/contracts/settings'
import { loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'

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
  return {
    catalog: subagentCatalogSnapshot(catalog, settings.enabledSubagents),
  }
}
