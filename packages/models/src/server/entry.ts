import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'
import { createModelHandlers, type ModelHandlerContext } from './handlers'

export const manifest: PluginManifest = {
  name: '@pi-meme/models',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 2,
    server: 'dist/server/chord-facets.json',
    requires: ['host.models'],
  },
}

export function create(context: ServerPluginContext) {
  context.registerHandlers(createModelHandlers(context.services.require<ModelHandlerContext>('host.models')))
}
