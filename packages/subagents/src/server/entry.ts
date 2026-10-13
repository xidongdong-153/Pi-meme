import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'
import type { DesktopSettings, SubagentCatalogSnapshot } from '@pi-meme/contracts/settings'
import type { PiRuntime } from '@pi-meme/pi-runtime/runtime'

export const manifest: PluginManifest = {
  name: '@pi-meme/subagents',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 2,
    server: 'dist/server/chord-facets.json',
    agent: 'dist/agent/entry.js',
    requires: ['host.settings'],
  },
}
export function create(context: ServerPluginContext) {
  const host = context.services.require<{
    pi: PiRuntime
    settings: { snapshot: () => { settings: DesktopSettings } }
    getSubagents?: () => Promise<SubagentCatalogSnapshot>
    configureOptionalExtensions?: (settings: DesktopSettings) => Promise<SubagentCatalogSnapshot>
  }>('host.settings')
  context.registerHandlers({
    'settings:subagents': () => host.getSubagents?.() ?? { directory: '', agents: [], diagnostics: [] },
    'settings:reload-subagents': () =>
      host.pi.idle(async () => {
        const settings = host.settings.snapshot().settings
        const catalog = await host.configureOptionalExtensions?.(settings)
        if (settings.subagentsEnabled) await host.pi.reconnectModels()
        return catalog ?? host.getSubagents?.() ?? { directory: '', agents: [], diagnostics: [] }
      }, true),
  })
}
