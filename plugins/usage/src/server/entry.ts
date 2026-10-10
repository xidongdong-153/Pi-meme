import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'
import { UsageService } from './usage-service'

export const manifest: PluginManifest = {
  name: '@pi-meme/usage',
  version: '0.1.0',
  piMeme: {
    sdkVersion: 1,
    server: 'dist/server/chord-facets.json',
    ui: 'dist/ui/entry.js',
    requires: ['host.usage'],
  },
}
export function create(context: ServerPluginContext) {
  const { sessionsDirectory } = context.services.require<{ sessionsDirectory: string }>('host.usage')
  const usage = new UsageService(sessionsDirectory)
  context.registerHandlers({ 'settings:usage-stats': () => usage.getSnapshot() })
}
