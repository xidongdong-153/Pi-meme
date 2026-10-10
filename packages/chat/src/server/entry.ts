import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'
import { createChatHandlers, type ChatHandlerContext } from './handlers'

export const manifest: PluginManifest = {
  name: '@pi-meme/chat',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 1,
    server: 'dist/server/chord-facets.json',
    ui: 'dist/ui/entry.js',
    requires: ['host.chat'],
  },
}

export function create(context: ServerPluginContext) {
  const host = context.services.require<
    ChatHandlerContext & { handlers?: Record<string, (...args: unknown[]) => unknown> }
  >('host.chat')
  context.registerHandlers({ ...createChatHandlers(host), ...host.handlers })
}
