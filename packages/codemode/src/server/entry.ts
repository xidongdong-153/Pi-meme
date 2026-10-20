import type {
  BuiltinModuleDescriptor as PluginManifest,
  BuiltinModuleContext as ServerPluginContext,
} from '@pi-meme/contracts/builtin-module'

export const manifest: PluginManifest = {
  name: '@pi-meme/codemode',
  version: '0.1.0',
  piMeme: { sdkVersion: 3, agent: 'dist/agent/entry.js', ui: 'dist/ui/entry.js' },
}
export function create(_context: ServerPluginContext) {}
