import type {
  ResourceCatalog,
  ResourceImportInput,
  ResourceItem,
  ResourcePolicyInput,
  ResourceSkillSaveInput,
} from '@pi-meme/contracts/resources'

export type ResourceClient = {
  catalog: (cwd?: string) => Promise<ResourceCatalog>
  detail: (id: string, cwd?: string) => Promise<ResourceItem>
  import: (input: ResourceImportInput, cwd?: string) => Promise<ResourceCatalog>
  remove: (id: string, cwd?: string) => Promise<ResourceCatalog>
  readSkill: (id: string, cwd?: string) => Promise<{ item: ResourceItem; content: string }>
  saveSkill: (input: ResourceSkillSaveInput, cwd?: string) => Promise<ResourceCatalog>
  setPolicy: (input: ResourcePolicyInput) => Promise<ResourceCatalog>
  refresh: (cwd?: string) => Promise<ResourceCatalog>
  onChange: (callback: () => void) => () => void
}

export function createResourceClient(
  call: <T>(method: string, args?: unknown[]) => Promise<T>,
  onChange: ResourceClient['onChange'],
): ResourceClient {
  return {
    catalog: (cwd) => call('resources:catalog', [cwd]),
    detail: (id, cwd) => call('resources:detail', [id, cwd]),
    import: (input, cwd) => call('resources:import', [input, cwd]),
    remove: (id, cwd) => call('resources:remove', [id, cwd]),
    readSkill: (id, cwd) => call('resources:read-skill', [id, cwd]),
    saveSkill: (input, cwd) => call('resources:save-skill', [input, cwd]),
    setPolicy: (input) => call('resources:set-policy', [input]),
    refresh: (cwd) => call('resources:refresh', [cwd]),
    onChange,
  }
}
