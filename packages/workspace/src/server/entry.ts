import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'
import { createWorkspaceHandlers, type WorkspaceHandlerContext } from './handlers'

export const manifest: PluginManifest = {
  name: '@pi-meme/workspace',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 1,
    server: 'dist/server/chord-facets.json',
    ui: 'dist/ui/entry.js',
    requires: ['host.workspace'],
  },
}

export function create(context: ServerPluginContext) {
  const host = context.services.require<
    WorkspaceHandlerContext & { handlers?: Record<string, (...args: unknown[]) => unknown> }
  >('host.workspace')
  context.registerHandlers({ ...createWorkspaceHandlers(host), ...host.handlers })
}
