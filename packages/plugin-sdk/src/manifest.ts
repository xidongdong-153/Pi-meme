export const pluginSdkVersion = 1

export type PluginDisplay = { name?: string; icon?: string }
export type PluginResources = { skills?: string[]; extensions?: string[] }

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
    display?: PluginDisplay
    resources?: PluginResources
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
  if (config.display !== undefined) {
    const display = config.display
    if (!display || typeof display !== 'object' || Array.isArray(display)) throw new Error('插件 display 必须是对象')
    if (display.name !== undefined && (typeof display.name !== 'string' || !display.name.trim()))
      throw new Error('插件显示名称不能为空')
    if (
      display.icon !== undefined &&
      (typeof display.icon !== 'string' ||
        !safeResourcePath(display.icon) ||
        !/\.(?:svg|png|jpe?g|webp)$/i.test(display.icon))
    )
      throw new Error('插件图标必须是包内 SVG、PNG、JPEG 或 WebP 文件')
  }
  if (config.resources !== undefined) {
    const resources = config.resources
    if (!resources || typeof resources !== 'object' || Array.isArray(resources))
      throw new Error('插件 resources 必须是对象')
    if (Object.keys(resources).some((key) => key !== 'skills' && key !== 'extensions'))
      throw new Error('插件 resources 只支持 skills 和 extensions')
    for (const kind of ['skills', 'extensions'] as const) {
      const paths = resources[kind]
      if (
        paths !== undefined &&
        (!Array.isArray(paths) || paths.some((entry) => typeof entry !== 'string' || !safeResourcePath(entry)))
      )
        throw new Error(`插件 resources.${kind} 必须是包内相对路径数组，不支持通配符`)
      if (paths && new Set(paths).size !== paths.length) throw new Error(`插件 resources.${kind} 不能重复`)
    }
    if (config.agent && resources.extensions?.includes(config.agent))
      throw new Error('插件 agent 与 resources.extensions 不能声明同一入口')
  }
  return manifest as PluginManifest
}

export function safeResourcePath(value: string) {
  return (
    safeRelativePath(value) &&
    !/[*?#[\]{}:%]/.test(value) &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
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
