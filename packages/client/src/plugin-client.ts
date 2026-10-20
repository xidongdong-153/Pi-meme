import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import type { PluginGrantUpdate } from '@pi-meme/plugin-sdk/permissions'
import type { PluginCallRequest, PluginUiLease } from '@pi-meme/plugin-sdk/rpc'

export type PluginCredentialInput = { id: string; origin: string; header: 'Authorization' | 'X-Api-Key'; value: string }
export type PluginCredential = Omit<PluginCredentialInput, 'value'>

export type PluginClient = {
  list: () => Promise<UiPluginDescriptor[]>
  setGrant: (id: string, update: PluginGrantUpdate) => Promise<UiPluginDescriptor>
  callOperation: (request: PluginCallRequest, signal?: AbortSignal) => Promise<unknown>
  acquireUiLease: (input: { pluginId: string; generation: number; routeInstance: string }) => Promise<PluginUiLease>
  renewUiLease: (id: string) => Promise<PluginUiLease>
  releaseUiLease: (id: string) => Promise<void>
  listCredentials: (id: string) => Promise<PluginCredential[]>
  setCredential: (id: string, input: PluginCredentialInput) => Promise<void>
  removeCredential: (id: string, credentialId: string) => Promise<void>
  installDirectory: (path: string) => Promise<unknown>
  installPackage: (base64: string) => Promise<unknown>
  reload: (id: string) => Promise<unknown>
  enable: (id: string) => Promise<unknown>
  disable: (id: string) => Promise<unknown>
  remove: (id: string) => Promise<unknown>
  onChange: (callback: () => void) => () => void
}
