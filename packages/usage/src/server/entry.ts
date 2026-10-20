import type {
  BuiltinModuleDescriptor as PluginManifest,
  BuiltinModuleContext as ServerPluginContext,
} from '@pi-meme/contracts/builtin-module'
import { UsageService } from './usage-service'

export const manifest: PluginManifest = {
  name: '@pi-meme/usage',
  version: '0.1.0',
  piMeme: {
    sdkVersion: 3,
    server: 'dist/server/chord-facets.json',
    requires: ['host.usage'],
  },
}
export function create(context: ServerPluginContext) {
  const { sessionsDirectory } = context.services.require<{ sessionsDirectory: string }>('host.usage')
  const usage = new UsageService(sessionsDirectory)
  context.registerHandlers({ 'settings:usage-stats': () => usage.getSnapshot() })
}
