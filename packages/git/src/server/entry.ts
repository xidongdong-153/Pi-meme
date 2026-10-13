import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'
import { createGitHandlers, type GitHandlerContext } from './handlers'

export const manifest: PluginManifest = {
  name: '@pi-meme/git',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 2,
    server: 'dist/server/chord-facets.json',
    requires: ['host.git'],
  },
}

export function create(context: ServerPluginContext) {
  context.registerHandlers(createGitHandlers(context.services.require<GitHandlerContext>('host.git')))
}
