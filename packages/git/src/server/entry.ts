import type {
  BuiltinModuleDescriptor as PluginManifest,
  BuiltinModuleContext as ServerPluginContext,
} from '@pi-meme/contracts/builtin-module'
import { createGitHandlers, type GitHandlerContext } from './handlers'

export const manifest: PluginManifest = {
  name: '@pi-meme/git',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 3,
    server: 'dist/server/chord-facets.json',
    requires: ['host.git'],
  },
}

export function create(context: ServerPluginContext) {
  context.registerHandlers(createGitHandlers(context.services.require<GitHandlerContext>('host.git')))
}
