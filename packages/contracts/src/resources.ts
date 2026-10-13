export type ResourceKind = 'skill' | 'app-plugin'
export type ResourceScope = 'builtin' | 'host' | 'project'
export type ResourceInvocation = 'automatic' | 'manual'
export type ResourcePolicy = { enabled?: boolean; invocation?: ResourceInvocation }
export type ResourceOwner = {
  id: string
  type: 'loose' | 'app-package' | 'builtin'
  name?: string
  version?: string
  generation?: number
}
export type ResourceItem = {
  id: string
  kind: ResourceKind
  name: string
  displayName?: string
  description?: string
  shortDescription?: string
  revision: string
  path: string
  sourcePath: string
  baseDir: string
  scope: ResourceScope
  owner: ResourceOwner
  enabled: boolean
  defaultPolicy: ResourcePolicy
  hostPolicy?: ResourcePolicy
  projectPolicy?: ResourcePolicy
  invocation: ResourceInvocation
  shadowedBy?: string
  diagnostics: string[]
  editable: boolean
}
export type ResourceSnapshot = {
  id: string
  generation: number
  cwd: string
  skills: ResourceItem[]
  appPlugins?: ResourceItem[]
}
export type ResourceCatalog = {
  hostId?: string
  generation: number
  cwd?: string
  dataRoot: string
  items: ResourceItem[]
  diagnostics: string[]
}
export type ResourceImportInput = {
  replace?: { id: string; revision: string }
  kind?: 'skill'
  path?: string
  name?: string
  content?: string
  archiveBase64?: string
  files?: Array<{ path: string; content: string; encoding?: 'utf8' | 'base64' }>
}
export type ResourceSkillSaveInput = { id?: string; name?: string; content: string; revision?: string }
export type ResourcePolicyInput = {
  id: string
  scope: 'host' | 'project'
  reset?: boolean
  cwd?: string
  enabled?: boolean
  invocation?: ResourceInvocation
}
export type ResourceAppPackage = {
  id: string
  version: string
  generation: number
  directory: string
  enabled: boolean
  display?: { name?: string; description?: string }
  resources?: { skills?: string[]; themes?: string[]; assets?: string[] }
}
