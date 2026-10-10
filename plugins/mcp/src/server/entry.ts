import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'
import { createMcpHandlers } from './handlers'

export const manifest: PluginManifest = {
  name: '@pi-meme/mcp',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 1,
    server: 'dist/server/chord-facets.json',
    ui: 'dist/ui/entry.js',
    agent: 'dist/agent/entry.js',
    requires: ['host.mcp'],
  },
}

export function create(context: ServerPluginContext) {
  context.registerHandlers(
    createMcpHandlers(context.services.require<Parameters<typeof createMcpHandlers>[0]>('host.mcp')),
  )
}
