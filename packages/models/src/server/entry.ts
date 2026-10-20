import type {
  BuiltinModuleDescriptor as PluginManifest,
  BuiltinModuleContext as ServerPluginContext,
} from '@pi-meme/contracts/builtin-module'
import { createModelHandlers, type ModelHandlerContext } from './handlers'

export const manifest: PluginManifest = {
  name: '@pi-meme/models',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 3,
    server: 'dist/server/chord-facets.json',
    requires: ['host.models'],
  },
}

export function create(context: ServerPluginContext) {
  context.registerHandlers(createModelHandlers(context.services.require<ModelHandlerContext>('host.models')))
}
