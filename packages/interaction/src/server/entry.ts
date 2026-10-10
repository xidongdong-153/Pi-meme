import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'
import { createExtensionHandlers, type ExtensionHandlerContext } from './handlers'

export const manifest: PluginManifest = {
  name: '@pi-meme/pi-extensions',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 1,
    server: 'dist/server/chord-facets.json',
    agent: 'dist/agent/entry.js',
    ui: 'dist/ui/entry.js',
    requires: ['host.interaction'],
  },
}

export function create(context: ServerPluginContext) {
  context.registerHandlers(
    createExtensionHandlers(context.services.require<ExtensionHandlerContext>('host.interaction')),
  )
}
