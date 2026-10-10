import type { UiPluginModule } from '@pi-meme/plugin-sdk/ui'

export function loadPluginUI(url: string) {
  return import(/* @vite-ignore */ url) as Promise<UiPluginModule>
}
