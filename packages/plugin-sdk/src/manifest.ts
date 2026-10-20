import { pluginUiCapabilities, type PluginPermissions } from './permissions'

export const pluginSdkVersion = 3
export type PluginDisplay = { name?: string; icon?: string }
export type PluginResources = { skills?: string[]; themes?: string[]; assets?: string[] }
export type PluginEntries = { trusted?: string; restricted?: string }
export type PluginManifest = {
  name: string
  version: string
  description?: string
  type?: 'module'
  piMeme: {
    sdkVersion: 3
    server?: PluginEntries
    agent?: PluginEntries
    ui?: string
    requires?: string[]
    provides?: string[]
    display?: PluginDisplay
    resources?: PluginResources
    permissions?: PluginPermissions
  }
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
export function safeResourcePath(value: string) {
  return (
    safeRelativePath(value) &&
    !/[*?#[\]{}:%]/.test(value) &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
}
function names(value: unknown, field: string): asserts value is string[] | undefined {
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      value.some((v) => typeof v !== 'string' || !v.trim()) ||
      new Set(value).size !== value.length)
  )
    throw new Error(`插件 ${field} 必须是不重复的非空名称数组`)
}
export function parsePluginManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件 package.json 必须是对象')
  const m = value as PluginManifest
  if (typeof m.name !== 'string' || !/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(m.name))
    throw new Error('插件 name 必须是合法的 npm 包名')
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(m.version))
    throw new Error('插件 version 必须是语义版本号')
  const c = m.piMeme
  if (!c || typeof c !== 'object' || c.sdkVersion !== 3) throw new Error('unsupported-sdk: 插件必须升级至 SDK 3 重建')
  if (m.description !== undefined && typeof m.description !== 'string') throw new Error('插件 description 必须是字符串')
  const paths: string[] = []
  for (const kind of ['server', 'agent'] as const) {
    const entries = c[kind]
    if (entries === undefined) continue
    if (
      !entries ||
      typeof entries !== 'object' ||
      Array.isArray(entries) ||
      !Object.keys(entries).length ||
      Object.keys(entries).some((k) => !['trusted', 'restricted'].includes(k))
    )
      throw new Error(`插件 ${kind} 必须声明 trusted/restricted 入口`)
    for (const runtime of ['trusted', 'restricted'] as const) {
      const p = entries[runtime]
      if (p === undefined) continue
      if (
        typeof p !== 'string' ||
        !safeResourcePath(p) ||
        !(kind === 'server' && runtime === 'trusted' ? p.endsWith('chord-facets.json') : p.endsWith('.js'))
      )
        throw new Error(`插件 ${kind}.${runtime} 必须是包内构建产物`)
      paths.push(p)
    }
  }
  if (c.ui !== undefined) {
    if (typeof c.ui !== 'string' || !safeResourcePath(c.ui) || !c.ui.endsWith('.js'))
      throw new Error('插件 ui 必须是包内 .js')
    paths.push(c.ui)
  }
  if (new Set(paths).size !== paths.length) throw new Error('可信与受限入口不能指向同一产物')
  for (const k of ['requires', 'provides'] as const) names(c[k], k)
  if ((c.requires?.length || c.provides?.length) && !c.server?.trusted)
    throw new Error('只有可信 Server 可以声明 requires/provides')
  if (c.display !== undefined) {
    if (!c.display || typeof c.display !== 'object' || Array.isArray(c.display))
      throw new Error('插件 display 必须是对象')
    if (c.display.name !== undefined && (typeof c.display.name !== 'string' || !c.display.name.trim()))
      throw new Error('插件显示名称不能为空')
    if (
      c.display.icon !== undefined &&
      (typeof c.display.icon !== 'string' ||
        !safeResourcePath(c.display.icon) ||
        !/\.(?:svg|png|jpe?g|webp)$/i.test(c.display.icon))
    )
      throw new Error('插件图标必须是包内图片')
  }
  if (c.resources !== undefined) {
    if (
      !c.resources ||
      typeof c.resources !== 'object' ||
      Array.isArray(c.resources) ||
      Object.keys(c.resources).some((k) => !['skills', 'themes', 'assets'].includes(k))
    )
      throw new Error('插件 resources 只支持 skills、themes 和 assets')
    for (const k of ['skills', 'themes', 'assets'] as const) {
      names(c.resources[k], `resources.${k}`)
      if (c.resources[k]?.some((p) => !safeResourcePath(p))) throw new Error(`插件 resources.${k} 必须是包内相对路径`)
    }
  }
  const p = c.permissions
  if (p !== undefined) {
    if (
      !p ||
      typeof p !== 'object' ||
      Array.isArray(p) ||
      Object.keys(p).some((k) => !['ui', 'restricted', 'beforeSend'].includes(k))
    )
      throw new Error('插件 permissions 字段无效')
    names(p.ui, 'permissions.ui')
    names(p.beforeSend, 'permissions.beforeSend')
    if (p.ui?.some((k) => !pluginUiCapabilities.includes(k))) throw new Error('插件声明了未知 UI 能力')
    const r = p.restricted
    if (r !== undefined) {
      if (!r || !['read-only', 'workspace-write'].includes(r.maxAccess)) throw new Error('受限插件 maxAccess 无效')
      names(r.capabilities, 'capabilities')
      names(r.sharedData, 'sharedData')
      if (
        r.capabilities?.some(
          (k) =>
            !['workspace.read', 'workspace.write', 'interaction.request', 'http.request', 'sharedData.read'].includes(
              k,
            ),
        )
      )
        throw new Error('插件声明了未知受限能力')
      if (r.network !== undefined && !Array.isArray(r.network)) throw new Error('网络规则必须是数组')
      const ids = new Set<string>()
      for (const rule of r.network ?? []) {
        if (!rule || typeof rule.id !== 'string' || !/^[\w-]+$/.test(rule.id) || ids.has(rule.id))
          throw new Error('网络规则 id 无效或重复')
        ids.add(rule.id)
        let u: URL
        try {
          u = new URL(rule.origin)
        } catch {
          throw new Error('网络规则必须声明有效 HTTPS origin')
        }
        if (
          u.protocol !== 'https:' ||
          u.username ||
          u.password ||
          u.origin !== rule.origin ||
          u.hostname.includes('*') ||
          !Array.isArray(rule.methods) ||
          !rule.methods.length ||
          rule.methods.some((v) => !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(v))
        )
          throw new Error('网络规则必须是精确 HTTPS origin 与 method')
      }
    }
  }
  if (!paths.length && !Object.values(c.resources ?? {}).some((v) => v?.length))
    throw new Error('插件必须声明入口或包内资源')
  return m
}
export function contributionId(pluginId: string, localId: string) {
  if (!localId.trim() || localId.includes(':')) throw new Error('贡献名称不能为空或包含冒号')
  return `${pluginId}:${localId}`
}
