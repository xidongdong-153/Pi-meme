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
  const { sessionsDirectory, backgroundDirectory } = context.services.require<{
    sessionsDirectory: string
    backgroundDirectory?: string
  }>('host.usage')
  const usage = new UsageService(sessionsDirectory, undefined, backgroundDirectory)
  context.registerHandlers({ 'settings:usage-stats': () => usage.getSnapshot() })
}
