import type { PluginManifest } from './manifest'

export const reservedPluginIds = [
  '@pi-meme/browser',
  '@pi-meme/chat',
  '@pi-meme/workspace',
  '@pi-meme/git',
  '@pi-meme/file-directory',
  '@pi-meme/terminal',
  '@pi-meme/models',
  '@pi-meme/image-generation',
  '@pi-meme/visualize',
  '@pi-meme/settings',
  '@pi-meme/interaction',
  '@pi-meme/mcp',
  '@pi-meme/history',
  '@pi-meme/usage',
  '@pi-meme/resources',
  '@pi-meme/sandbox-macos',
  '@pi-meme/sandbox-linux',
  '@pi-meme/permissions',
  '@pi-meme/codemode',
  '@pi-meme/subagents',
  '@pi-meme/goals',
  '@pi-meme/activities',
  '@pi-meme/schedules',
] as const

export const reservedServiceNames = [
  'host.goals',
  'host.schedules',
  'host.usage',
  'host.chat',
  'host.workspace',
  'host.git',
  'host.models',
  'host.image-generation',
  'host.settings',
  'host.interaction',
  'host.mcp',
  'agent.sandbox',
  'agent.permissions',
] as const

export function isReservedPluginId(id: string) {
  return (reservedPluginIds as readonly string[]).includes(id)
}

export function assertExternalPluginId(id: string) {
  if (isReservedPluginId(id)) throw new Error(`内置模块不能通过插件接口修改：${id}`)
}

export function assertExternalManifest(manifest: PluginManifest) {
  assertExternalPluginId(manifest.name)
  for (const name of manifest.piMeme.requires ?? []) {
    if (/^(?:host|agent)\./.test(name)) throw new Error(`外部插件不能调用内置装配服务：${name}；请使用 context.host`)
  }
  for (const name of manifest.piMeme.provides ?? []) {
    if ((reservedServiceNames as readonly string[]).includes(name) || /^(?:host|agent)\./.test(name))
      throw new Error(`外部插件不能提供内置服务：${name}`)
  }
}
