export const pluginUiCapabilities = [
  'composer.read',
  'composer.write',
  'composer.attachments',
  'composer.submit',
  'composer.before-send',
  'messages.read',
  'messages.actions',
  'navigation.pages',
  'reactive.read',
] as const
export type PluginUiCapability = (typeof pluginUiCapabilities)[number]
export type RestrictedCapability =
  'workspace.read' | 'workspace.write' | 'interaction.request' | 'http.request' | 'sharedData.read'
export type PluginHttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type PluginNetworkPermission = { id: string; origin: string; methods: PluginHttpMethod[] }
export type RestrictedPermissions = {
  maxAccess: 'read-only' | 'workspace-write'
  capabilities?: RestrictedCapability[]
  network?: PluginNetworkPermission[]
  sharedData?: string[]
}
export type PluginPermissions = {
  restricted?: RestrictedPermissions
  ui?: PluginUiCapability[]
  beforeSend?: string[]
}
export type PluginGrant = {
  policyHash: string
  revision: number
  trusted: { ui: boolean; server: boolean; agent: boolean }
  ui: PluginUiCapability[]
  restricted: RestrictedPermissions
  beforeSend: string[]
}
export type PluginGrantUpdate = Omit<PluginGrant, 'revision'> & { expectedRevision: number }

export function emptyPluginGrant(policyHash: string, revision = 0): PluginGrant {
  return {
    policyHash,
    revision,
    trusted: { ui: false, server: false, agent: false },
    ui: [],
    restricted: { maxAccess: 'read-only', capabilities: [], network: [], sharedData: [] },
    beforeSend: [],
  }
}
