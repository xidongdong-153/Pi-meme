import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'
import { createExtensionHandlers, type ExtensionHandlerContext } from './handlers'

export const manifest: PluginManifest = {
  name: '@pi-meme/interaction',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 2,
    server: 'dist/server/chord-facets.json',
    agent: 'dist/agent/entry.js',
    requires: ['host.interaction'],
  },
}

export function create(context: ServerPluginContext) {
  context.registerHandlers(
    createExtensionHandlers(context.services.require<ExtensionHandlerContext>('host.interaction')),
  )
}
