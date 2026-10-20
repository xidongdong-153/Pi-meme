import type {
  BuiltinModuleDescriptor as PluginManifest,
  BuiltinModuleContext as ServerPluginContext,
} from '@pi-meme/contracts/builtin-module'
import { createWorkspaceHandlers, type WorkspaceHandlerContext } from './handlers'

export const manifest: PluginManifest = {
  name: '@pi-meme/workspace',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 3,
    server: 'dist/server/chord-facets.json',
    requires: ['host.workspace'],
  },
}

export function create(context: ServerPluginContext) {
  const host = context.services.require<
    WorkspaceHandlerContext & { handlers?: Record<string, (...args: unknown[]) => unknown> }
  >('host.workspace')
  context.registerHandlers({ ...createWorkspaceHandlers(host), ...host.handlers })
}
