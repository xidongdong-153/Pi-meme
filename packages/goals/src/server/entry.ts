import type {
  BuiltinModuleDescriptor as PluginManifest,
  BuiltinModuleContext as ServerPluginContext,
} from '@pi-meme/contracts/builtin-module'

export const manifest: PluginManifest = {
  name: '@pi-meme/goals',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 3,
    server: 'dist/server/chord-facets.json',
    agent: 'dist/agent/entry.js',
    requires: ['host.goals'],
  },
}
export function create(context: ServerPluginContext) {
  context.services.require('host.goals')
}
