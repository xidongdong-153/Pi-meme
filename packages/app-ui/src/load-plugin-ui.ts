import type { UiPluginModule } from '@pi-meme/plugin-sdk/ui'

const builtins: Record<string, () => Promise<UiPluginModule>> = {
  '@pi-meme/history': () => import('@pi-meme/history/ui/plugin'),
  '@pi-meme/permissions': () => import('@pi-meme/permissions/ui/plugin'),
  '@pi-meme/resources': () => import('@pi-meme/resources/ui/plugin'),
  '@pi-meme/codemode': () => import('@pi-meme/codemode/ui/plugin'),
  '@pi-meme/subagents': () => import('@pi-meme/subagents/ui/plugin'),
  '@pi-meme/usage': () => import('@pi-meme/usage/ui/plugin'),
  '@pi-meme/chat': () => import('@pi-meme/chat/ui/plugin'),
  '@pi-meme/workspace': () => import('@pi-meme/workspace/ui/plugin'),
  '@pi-meme/git': () => import('@pi-meme/git/ui/plugin'),
  '@pi-meme/models': () => import('@pi-meme/models/ui/plugin'),
  '@pi-meme/settings': () => import('@pi-meme/settings/ui/plugin'),
  '@pi-meme/mcp': () => import('@pi-meme/mcp/ui/plugin'),
  '@pi-meme/pi-extensions': () => import('@pi-meme/pi-extensions/ui/plugin'),
}

export function loadPluginUI(url: string) {
  if (url.startsWith('builtin:')) {
    const load = builtins[url.slice('builtin:'.length)]
    if (!load) throw new Error(`内置插件没有 UI 入口：${url}`)
    return load()
  }
  return import(/* @vite-ignore */ url) as Promise<UiPluginModule>
}
