import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'
import { createGitHandlers, type GitHandlerContext } from './handlers'

export const manifest: PluginManifest = {
  name: '@pi-meme/git',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 1,
    server: 'dist/server/chord-facets.json',
    ui: 'dist/ui/entry.js',
    requires: ['host.git'],
  },
}

export function create(context: ServerPluginContext) {
  context.registerHandlers(createGitHandlers(context.services.require<GitHandlerContext>('host.git')))
}
