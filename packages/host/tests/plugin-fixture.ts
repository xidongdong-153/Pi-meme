import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PluginManager } from '@pi-meme/plugin-runtime/manager'
import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'

export function agentFixtureManifest(name: string, version = '1.0.0', trusted = 'dist/agent.js'): PluginManifest {
  return {
    name,
    version,
    type: 'module',
    piMeme: {
      sdkVersion: 3,
      agent: { trusted, restricted: trusted.replace(/\.js$/, '.restricted.js') },
      permissions: { restricted: { maxAccess: 'read-only', capabilities: ['interaction.request'] } },
    },
  }
}

export async function writeAgentFixture(
  directory: string,
  id: string,
  content: string,
  version = '1.0.0',
  trusted = 'dist/agent.js',
) {
  const manifest = agentFixtureManifest(id, version, trusted)
  await mkdir(path.dirname(path.join(directory, trusted)), { recursive: true })
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest))
  await writeFile(path.join(directory, trusted), content)
  await writeFile(path.join(directory, manifest.piMeme.agent!.restricted!), content)
}

export async function trustPluginFixture(manager: PluginManager, id: string) {
  const descriptor = manager.list().find((entry) => entry.id === id)!
  return manager.setGrant(id, {
    ...descriptor.grant!,
    expectedRevision: descriptor.grant!.revision,
    policyHash: descriptor.policyHash!,
    trusted: {
      ui: Boolean(descriptor.ui),
      server: Boolean(descriptor.entries?.server?.trusted),
      agent: Boolean(descriptor.entries?.agent?.trusted),
    },
    restricted: descriptor.permissions?.restricted ?? {
      maxAccess: 'read-only',
      capabilities: [],
      network: [],
      sharedData: [],
    },
  })
}
