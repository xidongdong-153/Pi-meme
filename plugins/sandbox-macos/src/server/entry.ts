import { existsSync } from 'node:fs'
import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'
import { AccessSandbox, type AccessSandboxOptions } from '@pi-meme/pi-runtime/sdk/access-sandbox'

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
export function create(context: ServerPluginContext) {
  const running = new Set<AccessSandbox>()
  context.provide('agent.sandbox', {
    available: () => process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'),
    create: async (options: AccessSandboxOptions) => {
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
