import type {
  BuiltinModuleDescriptor as PluginManifest,
  BuiltinModuleContext as ServerPluginContext,
} from '@pi-meme/contracts/builtin-module'
import { createMcpHandlers } from './handlers'

export const manifest: PluginManifest = {
  name: '@pi-meme/mcp',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 3,
    server: 'dist/server/chord-facets.json',
    agent: 'dist/agent/entry.js',
    requires: ['host.mcp'],
  },
}

export function create(context: ServerPluginContext) {
  context.registerHandlers(
    createMcpHandlers(context.services.require<Parameters<typeof createMcpHandlers>[0]>('host.mcp')),
  )
}
