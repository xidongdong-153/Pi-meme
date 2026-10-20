import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { PluginGrant } from '@pi-meme/plugin-sdk/permissions'

export function validatePluginGrant(manifest: PluginManifest, policyHash: string, value: unknown): PluginGrant {
  const g = value as PluginGrant
  const requested = manifest.piMeme.permissions
  const r = g?.restricted
  const declared = requested?.restricted
  const array = (input: unknown): input is string[] =>
    Array.isArray(input) && input.every((v) => typeof v === 'string') && new Set(input).size === input.length
  if (
    !g ||
    g.policyHash !== policyHash ||
    !Number.isSafeInteger(g.revision) ||
    g.revision < 0 ||
    !g.trusted ||
    !['ui', 'server', 'agent'].every((v) => typeof g.trusted[v as keyof typeof g.trusted] === 'boolean') ||
    !array(g.ui) ||
    !array(g.beforeSend) ||
    !r ||
    !['read-only', 'workspace-write'].includes(r.maxAccess) ||
    !array(r.capabilities ?? []) ||
    !array(r.sharedData ?? []) ||
    !Array.isArray(r.network ?? [])
  )
    throw new Error('permission-denied: 插件授权记录格式无效')
  if (
    g.ui.some((v) => !requested?.ui?.includes(v)) ||
    g.beforeSend.some((v) => !requested?.beforeSend?.includes(v)) ||
    (g.trusted.ui && !manifest.piMeme.ui) ||
    (g.trusted.server && !manifest.piMeme.server?.trusted) ||
    (g.trusted.agent && !manifest.piMeme.agent?.trusted)
  )
    throw new Error('permission-denied: 未声明 UI 能力或可信入口')
  if (
    (r.maxAccess === 'workspace-write' && declared?.maxAccess !== 'workspace-write') ||
    (r.maxAccess === 'read-only' && r.capabilities?.includes('workspace.write')) ||
    r.capabilities?.some((v) => !declared?.capabilities?.includes(v)) ||
    r.sharedData?.some((v) => !declared?.sharedData?.includes(v))
  )
    throw new Error('permission-denied: 未声明受限能力')
  const networkIds = new Set<string>()
  for (const rule of r.network ?? []) {
    if (
      !rule ||
      typeof rule.id !== 'string' ||
      networkIds.has(rule.id) ||
      !array(rule.methods) ||
      !rule.methods.length ||
      !declared?.network?.some(
        (d) => d.id === rule.id && d.origin === rule.origin && rule.methods.every((m) => d.methods.includes(m)),
      )
    )
      throw new Error('permission-denied: 网络授权与声明不符')
    networkIds.add(rule.id)
  }
  return structuredClone({
    policyHash,
    revision: g.revision,
    trusted: { ui: g.trusted.ui, server: g.trusted.server, agent: g.trusted.agent },
    ui: g.ui,
    restricted: {
      maxAccess: r.maxAccess,
      capabilities: r.capabilities ?? [],
      network: r.network ?? [],
      sharedData: r.sharedData ?? [],
    },
    beforeSend: g.beforeSend,
  })
}
