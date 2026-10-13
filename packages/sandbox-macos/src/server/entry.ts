import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'
import {
  AccessSandbox,
  probeAccessSandbox,
  type AccessSandboxOperations,
  type AccessSandboxOptions,
} from '@pi-meme/pi-runtime/sdk/access-sandbox'

export const manifest: PluginManifest = {
  name: '@pi-meme/sandbox-macos',
  version: '0.1.0',
  piMeme: {
    sdkVersion: 1,
    server: 'dist/server/chord-facets.json',
    agent: 'dist/agent/entry.js',
    provides: ['agent.sandbox'],
  },
}
export async function create(context: ServerPluginContext) {
  const capability = await probeAccessSandbox()
  if (!capability.supported) console.error(capability.reason)
  const running = new Set<AccessSandboxOperations>()
  context.provide('agent.sandbox', {
    available: () => capability.supported,
    capability: () => ({ ...capability }),
    create: async (options: AccessSandboxOptions) => {
      if (!capability.supported) throw new Error(capability.reason ?? '受限权限沙箱不可用')
      const sandbox = await AccessSandbox.create(options)
      running.add(sandbox)
      return sandbox
    },
  })
  context.onDispose(() => {
    for (const sandbox of running) sandbox.stopAll()
    running.clear()
  })
}
