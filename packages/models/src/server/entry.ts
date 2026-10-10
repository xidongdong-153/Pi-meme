import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'
import { createModelHandlers, type ModelHandlerContext } from './handlers'

export const manifest: PluginManifest = {
  name: '@pi-meme/models',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 1,
    server: 'dist/server/chord-facets.json',
    ui: 'dist/ui/entry.js',
    requires: ['host.models'],
  },
}

export function create(context: ServerPluginContext) {
  context.registerHandlers(createModelHandlers(context.services.require<ModelHandlerContext>('host.models')))
}
