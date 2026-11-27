export const releaseRepositoryUrl = 'https://github.com/xidongdong-153/Pi-meme'
export const maxReleaseManifestBytes = 128 * 1024

export type AppReleaseTarget = {
  kind: 'desktop' | 'host' | 'docker'
  platform: 'darwin' | 'win32' | 'linux'
  arch: 'arm64' | 'x64'
}

export type AppReleaseAsset = AppReleaseTarget & { name: string; url: string; size: number; sha256: string }

export type AppReleaseManifest = {
  version: string
  tag: string
  channel: 'stable' | 'preview'
  notes: string
  assets: AppReleaseAsset[]
}

export type AppUpdateInstallation = {
  kind: AppReleaseTarget['kind']
  version: string
  platform: string
  arch: string
  development: boolean
  checkEnabled: boolean
  /** 仅由本机 Desktop 报告当前自有 Host，用于合并同一安装的更新。 */
  bundledHostId?: string
}

export type AppUpdateCheck = {
  status: 'available' | 'current' | 'ahead'
  version: string
  notes: string
  asset: AppReleaseAsset | null
}

export type AppUpdateReader = {
  getInfo: () => Promise<AppUpdateInstallation>
  check: (force?: boolean) => Promise<AppUpdateCheck>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isAppReleaseVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 80 &&
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-z\d-]+(?:\.[a-z\d-]+)*)?$/i.test(value)
  )
}

export function isReleaseNotes(value: unknown): value is string {
  return typeof value === 'string' && value.length <= maxReleaseManifestBytes && /\p{Script=Han}/u.test(value)
}

function releaseKind(value: unknown): value is AppReleaseTarget['kind'] {
  return value === 'desktop' || value === 'host' || value === 'docker'
}

export function releaseTagUrl(version: string) {
  return `${releaseRepositoryUrl}/releases/tag/v${encodeURIComponent(version)}`
}

export function releaseAssetName(version: string, target: AppReleaseTarget) {
  if (target.kind === 'docker')
    return `pi-meme-host-${version}-docker-linux-${target.arch === 'x64' ? 'amd64' : target.arch}.tar.gz`
  const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[target.platform]
  const extension = target.kind === 'desktop' ? 'zip' : 'tar.gz'
  return `pi-meme-${target.kind}-${version}-${platform}-${target.arch}.${extension}`
}

export function releaseAssetUrl(version: string, target: AppReleaseTarget) {
  return `${releaseRepositoryUrl}/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(releaseAssetName(version, target))}`
}

export function isAppReleaseAsset(value: unknown, version: string): value is AppReleaseAsset {
  if (!record(value)) return false
  const { kind, platform, arch, size, sha256 } = value
  if (
    !releaseKind(kind) ||
    (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') ||
    (kind === 'docker' && platform !== 'linux') ||
    (arch !== 'x64' && arch !== 'arm64')
  )
    return false
  const target = { kind, platform, arch } satisfies AppReleaseTarget
  return (
    value.name === releaseAssetName(version, target) &&
    value.url === releaseAssetUrl(version, target) &&
    typeof size === 'number' &&
    Number.isSafeInteger(size) &&
    size > 0 &&
    typeof sha256 === 'string' &&
    /^[a-f\d]{64}$/.test(sha256)
  )
}

export function isAppUpdateInstallation(value: unknown): value is AppUpdateInstallation {
  return (
    record(value) &&
    releaseKind(value.kind) &&
    isAppReleaseVersion(value.version) &&
    typeof value.platform === 'string' &&
    /^[a-z0-9_-]{1,32}$/.test(value.platform) &&
    typeof value.arch === 'string' &&
    /^[a-z0-9_-]{1,32}$/.test(value.arch) &&
    typeof value.development === 'boolean' &&
    typeof value.checkEnabled === 'boolean'
  )
}

export function isAppUpdateCheck(value: unknown): value is AppUpdateCheck {
  return (
    record(value) &&
    (value.status === 'available' || value.status === 'current' || value.status === 'ahead') &&
    isAppReleaseVersion(value.version) &&
    !value.version.includes('-') &&
    isReleaseNotes(value.notes) &&
    (value.asset === null || isAppReleaseAsset(value.asset, value.version))
  )
}
