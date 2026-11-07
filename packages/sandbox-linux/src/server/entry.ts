import type {
  BuiltinModuleDescriptor as PluginManifest,
  BuiltinModuleContext as ServerPluginContext,
} from '@pi-meme/contracts/builtin-module'
import { registerAccessSandbox } from '@pi-meme/pi-runtime/sdk/access-sandbox-service'

export const manifest: PluginManifest = {
  name: '@pi-meme/sandbox-linux',
  version: '0.1.0',
  piMeme: {
    sdkVersion: 3,
    server: 'dist/server/chord-facets.json',
    agent: 'dist/agent/entry.js',
    provides: ['agent.sandbox'],
  },
}
export async function create(context: ServerPluginContext) {
  await registerAccessSandbox(context)
}
