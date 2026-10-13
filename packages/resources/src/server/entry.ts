import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'
import type { ResourceImportInput, ResourcePolicyInput, ResourceSkillSaveInput } from '@pi-meme/contracts/resources'
import type { ResourceStore } from './resource-store'

export const manifest: PluginManifest = {
  name: '@pi-meme/resources',
  version: '0.1.0',
  piMeme: {
    sdkVersion: 2,
    server: 'dist/server/chord-facets.json',
    agent: 'dist/agent/entry.js',
    requires: ['host.resources'],
  },
}
export function create(context: ServerPluginContext) {
  const { store, getCwd } = context.services.require<{ store: ResourceStore; getCwd: () => string }>('host.resources')
  const cwd = (value?: unknown) => (typeof value === 'string' && value ? value : getCwd())
  const object = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资源参数必须是对象')
    return value
  }
  context.registerHandlers({
    'resources:catalog': (directory) => store.catalog(cwd(directory)),
    'resources:detail': async (id, directory) => {
      const item = (await store.catalog(cwd(directory))).items.find((entry) => entry.id === id)
      if (!item) throw new Error('资源不存在')
      return item
    },
    'resources:refresh': (directory) => store.refresh(cwd(directory)),
    'resources:import': (input, directory) => store.import(object(input) as ResourceImportInput, cwd(directory)),
    'resources:remove': async (id, directory) => {
      await store.remove(String(id))
      return store.catalog(cwd(directory))
    },
    'resources:read-skill': (id, directory) => store.readSkill(String(id), cwd(directory)),
    'resources:save-skill': (input, directory) =>
      store.saveSkill(object(input) as ResourceSkillSaveInput, cwd(directory)),
    'resources:set-policy': (input) => {
      const policy = object(input) as ResourcePolicyInput
      return store.setPolicy({ ...policy, cwd: policy.scope === 'project' ? cwd(policy.cwd) : policy.cwd })
    },
  })
}
