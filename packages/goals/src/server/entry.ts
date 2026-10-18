import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'

export const manifest: PluginManifest = {
  name: '@pi-meme/goals',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 2,
    server: 'dist/server/chord-facets.json',
    agent: 'dist/agent/entry.js',
    requires: ['host.goals'],
  },
}
export function create(context: ServerPluginContext) {
  context.services.require('host.goals')
}
