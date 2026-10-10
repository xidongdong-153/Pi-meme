export const pluginSdkVersion = 1

export type PluginManifest = {
  name: string
  version: string
  description?: string
  piMeme: {
    sdkVersion: 1
    server?: string
    agent?: string
    ui?: string
    requires?: string[]
    provides?: string[]
  }
}

export function parsePluginManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件 package.json 必须是对象')
  const manifest = value as Partial<PluginManifest>
  if (typeof manifest.name !== 'string' || !/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.name))
    throw new Error('插件 name 必须是合法的 npm 包名')
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(manifest.version))
    throw new Error('插件 version 必须是语义版本号')
  const config = manifest.piMeme
  if (manifest.description !== undefined && typeof manifest.description !== 'string')
    throw new Error('插件 description 必须是字符串')
  if (!config || typeof config !== 'object' || config.sdkVersion !== pluginSdkVersion)
    throw new Error(`插件 piMeme.sdkVersion 必须为 ${pluginSdkVersion}`)
  if (!config.server && !config.agent && !config.ui) throw new Error('插件必须声明 server、agent 或 ui 入口')
  for (const field of ['server', 'agent', 'ui'] as const) {
    const entry = config[field]
    if (
      entry !== undefined &&
      (typeof entry !== 'string' ||
        !(field === 'server' ? entry.endsWith('chord-facets.json') : entry.endsWith('.js')) ||
        !safeRelativePath(entry))
    )
      throw new Error(`插件 ${field} 入口必须是包内构建产物（server 为 chord-facets.json，agent/ui 为 .js）`)
  }
  for (const field of ['requires', 'provides'] as const) {
    const names = config[field]
    if (
      names !== undefined &&
      (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name.trim()))
    )
      throw new Error(`插件 ${field} 必须是服务名称数组`)
    if (names && new Set(names).size !== names.length) throw new Error(`插件 ${field} 不能重复`)
  }
  return manifest as PluginManifest
}

export function safeRelativePath(value: string) {
  return (
    Boolean(value) &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value.split('/').every((part) => part !== '..' && part !== '.' && part !== '')
  )
}

export function contributionId(pluginId: string, localId: string) {
  if (!localId.trim() || localId.includes(':')) throw new Error('贡献名称不能为空或包含冒号')
  return `${pluginId}:${localId}`
}
