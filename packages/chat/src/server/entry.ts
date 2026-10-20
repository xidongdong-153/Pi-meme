import type {
  BuiltinModuleDescriptor as PluginManifest,
  BuiltinModuleContext as ServerPluginContext,
} from '@pi-meme/contracts/builtin-module'
import { createChatHandlers, type ChatHandlerContext } from './handlers'

export const manifest: PluginManifest = {
  name: '@pi-meme/chat',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 3,
    server: 'dist/server/chord-facets.json',
    requires: ['host.chat'],
  },
}

export function create(context: ServerPluginContext) {
  const host = context.services.require<
    ChatHandlerContext & { handlers?: Record<string, (...args: unknown[]) => unknown> }
  >('host.chat')
  context.registerHandlers({ ...createChatHandlers(host), ...host.handlers })
}
