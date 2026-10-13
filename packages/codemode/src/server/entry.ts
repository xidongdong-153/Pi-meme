import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'

export const manifest: PluginManifest = {
  name: '@pi-meme/codemode',
  version: '0.1.0',
  piMeme: { sdkVersion: 2, agent: 'dist/agent/entry.js', ui: 'dist/ui/entry.js' },
}
export function create(_context: ServerPluginContext) {}
