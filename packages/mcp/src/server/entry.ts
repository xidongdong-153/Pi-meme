import type {
  BuiltinModuleDescriptor as PluginManifest,
  BuiltinModuleContext as ServerPluginContext,
} from '@pi-meme/contracts/builtin-module'
import { createMcpHandlers } from './handlers'
import { McpManagement, type McpManagementContext } from './management'

export const manifest: PluginManifest = {
  name: '@pi-meme/mcp',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 3,
    server: 'dist/server/chord-facets.json',
    agent: 'dist/agent/entry.js',
    requires: ['host.mcp'],
    provides: ['mcp.catalog'],
  },
}

export function create(context: ServerPluginContext) {
  const services = context.services.require<Parameters<typeof createMcpHandlers>[0] & McpManagementContext>('host.mcp')
  const manager = new McpManagement(services, services.store)
  context.provide('mcp.catalog', { read: (cwd: string) => manager.catalogForDirectory(cwd) })
  context.onDispose(() => manager.dispose())
  context.registerHandlers(createMcpHandlers(services, manager))
}
