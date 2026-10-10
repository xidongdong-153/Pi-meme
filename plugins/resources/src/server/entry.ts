import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'

export const manifest: PluginManifest = {
  name: '@pi-meme/resources',
  version: '0.1.0',
  piMeme: {
    sdkVersion: 1,
    server: 'dist/server/chord-facets.json',
    agent: 'dist/agent/entry.js',
    ui: 'dist/ui/entry.js',
    requires: ['host.models'],
  },
}
export function create(context: ServerPluginContext) {
  const { agentDir } = context.services.require<{ agentDir: string }>('host.models')
  context.registerHandlers({
    'resources:list': async (kind) => {
      if (kind !== 'skills' && kind !== 'extensions' && kind !== 'prompts')
        throw new Error('资源类型必须是 skills、extensions 或 prompts')
      const directory = path.join(agentDir, kind)
      try {
        const files = await readdir(directory, { withFileTypes: true })
        return files
          .filter((entry) => !entry.isSymbolicLink())
          .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw cause
      }
    },
  })
}
