import type {
  BuiltinModuleDescriptor as PluginManifest,
  BuiltinModuleContext as ServerPluginContext,
} from '@pi-meme/contracts/builtin-module'
import { createExtensionHandlers, type ExtensionHandlerContext } from './handlers'

export const manifest: PluginManifest = {
  name: '@pi-meme/interaction',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 3,
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
