import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'

export type PluginClient = {
  list: () => Promise<UiPluginDescriptor[]>
  installDirectory: (path: string) => Promise<unknown>
  installPackage: (base64: string) => Promise<unknown>
  reload: (id: string) => Promise<unknown>
  enable: (id: string) => Promise<unknown>
  disable: (id: string) => Promise<unknown>
  remove: (id: string) => Promise<unknown>
  onChange: (callback: () => void) => () => void
}
