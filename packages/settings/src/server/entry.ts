import type {
  BuiltinModuleDescriptor as PluginManifest,
  BuiltinModuleContext as ServerPluginContext,
} from '@pi-meme/contracts/builtin-module'
import { createSettingsHandlers, type SettingsHandlerContext } from './handlers'

export const manifest: PluginManifest = {
  name: '@pi-meme/settings',
  version: '0.0.0',
  piMeme: {
    sdkVersion: 3,
    server: 'dist/server/chord-facets.json',
    requires: ['host.settings'],
  },
}

export function create(context: ServerPluginContext) {
  const host = context.services.require<
    SettingsHandlerContext & { handlers?: Record<string, (...args: unknown[]) => unknown> }
  >('host.settings')
  context.registerHandlers({ ...createSettingsHandlers(host), ...host.handlers })
}
