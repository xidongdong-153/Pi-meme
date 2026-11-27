import {
  isAppReleaseAsset,
  isAppReleaseVersion,
  isReleaseNotes,
  maxReleaseManifestBytes,
  releaseRepositoryUrl,
  type AppReleaseAsset,
  type AppReleaseTarget,
  type AppUpdateCheck,
  type AppUpdateInstallation,
} from '@pi-meme/contracts/app-update'
import { responseBody } from './response-body'

const stableFeed = `${releaseRepositoryUrl}/releases/latest/download/latest.json`
const cacheMs = 60 * 60 * 1000
const invalidManifest = '稳定版更新清单格式无效，请稍后重试'

type UpdateOptions = { kind: AppReleaseTarget['kind']; version: string; packaged: boolean; developmentFeed?: string }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkManifest(value: unknown, installation: AppUpdateInstallation): AppUpdateCheck {
  if (!record(value)) throw new Error(invalidManifest)
  const { version, tag, channel, notes, assets } = value
  if (
    !isAppReleaseVersion(version) ||
    version.includes('-') ||
    channel !== 'stable' ||
    tag !== `v${version}` ||
    !isReleaseNotes(notes) ||
    !Array.isArray(assets) ||
    assets.length === 0 ||
    assets.length > 64 ||
    !assets.every((asset: unknown): asset is AppReleaseAsset => isAppReleaseAsset(asset, version))
  )
    throw new Error(invalidManifest)
  if (new Set(assets.map((asset) => asset.name)).size !== assets.length) throw new Error(invalidManifest)
  const matching = assets.find(
    (asset) =>
      asset.kind === installation.kind && asset.platform === installation.platform && asset.arch === installation.arch,
  )
  // 稳定源只含正式版。同一组主、次、修订号的稳定版高于本机预览版。
  if (!isAppReleaseVersion(installation.version)) throw new Error('无法识别当前 Pi meme 产品版本')
  const [core, prerelease] = installation.version.split('-', 2)
  const current = core.split('.').map(BigInt)
  const latest = version.split('.').map(BigInt)
  let status: AppUpdateCheck['status'] = prerelease ? 'available' : 'current'
  for (const [i, part] of latest.entries()) {
    if (part !== current[i]) {
      status = part > current[i] ? 'available' : 'ahead'
      break
    }
  }
  return { status, version, notes: notes.trim(), asset: matching ?? null }
}

function feedAllowed(url: URL, developmentOrigin?: string) {
  if (url.username || url.password) return false
  if (developmentOrigin) return url.origin === developmentOrigin && ['http:', 'https:'].includes(url.protocol)
  return (
    url.protocol === 'https:' &&
    ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.host)
  )
}

async function readManifest(feed: string, development: boolean) {
  const source = URL.parse(feed)
  if (!source) throw new Error('更新源地址无效')
  let url = source
  const developmentOrigin = development ? url.origin : undefined
  const signal = AbortSignal.timeout(12_000)
  for (let hop = 0; hop <= 4; hop++) {
    if (!feedAllowed(url, developmentOrigin)) throw new Error('更新源重定向到了未允许的地址')
    const response = await fetch(url, {
      signal,
      redirect: 'manual',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    }).catch(() => {
      throw new Error(signal.aborted ? '检查更新超时，请稍后重试' : '无法连接更新源，请检查网络后重试')
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      const next = location ? URL.parse(location, url) : null
      if (!next) throw new Error('更新源返回了无效的重定向')
      url = next
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        response.status === 404
          ? '当前稳定版尚未提供更新清单，可在发布页查看'
          : `更新源暂不可用（HTTP ${response.status}）`,
      )
    }
    const bytes = await responseBody(response, maxReleaseManifestBytes)
    try {
      return JSON.parse(bytes.toString('utf8')) as unknown
    } catch {
      throw new Error(invalidManifest)
    }
  }
  throw new Error('更新源重定向次数过多')
}

export function createAppUpdateService({ kind, version, packaged, developmentFeed }: UpdateOptions) {
  const feed = packaged ? stableFeed : developmentFeed
  const installation: AppUpdateInstallation = {
    kind,
    version,
    platform: process.platform,
    arch: process.arch,
    development: !packaged,
    checkEnabled: Boolean(feed),
  }
  let cached: { time: number; fresh: boolean; result: AppUpdateCheck } | undefined
  let pending: Promise<AppUpdateCheck> | undefined
  return {
    getInfo: () => installation,
    getLastCheck: () =>
      cached
        ? {
            status: cached.result.status,
            version: cached.result.version,
            checkedAt: new Date(cached.time).toISOString(),
          }
        : undefined,
    async check(force = false): Promise<AppUpdateCheck> {
      if (!feed) throw new Error('开发构建未启用更新检查')
      if (pending) return pending
      if (!force && cached?.fresh && Date.now() - cached.time < cacheMs) return cached.result
      if (cached) cached.fresh = false
      pending = readManifest(feed, !packaged)
        .then((manifest) => {
          const result = checkManifest(manifest, installation)
          cached = { time: Date.now(), fresh: true, result }
          return result
        })
        .finally(() => {
          pending = undefined
        })
      return pending
    },
  }
}

export type AppUpdateService = ReturnType<typeof createAppUpdateService>
