import { useCallback, useEffect, useRef, useState } from 'react'
import {
  releaseAssetName,
  releaseAssetUrl,
  releaseRepositoryUrl,
  releaseTagUrl,
  type AppUpdateCheck,
  type AppUpdateInstallation,
  type AppUpdateReader,
} from '@pi-meme/contracts/app-update'
import { Button, buttonVariants } from '@pi-meme/ui/components/ui/button'
import { SettingsCard, SettingsGroup, SettingsRow, settingsControlClassName } from '@pi-meme/ui/components/settings'

const releasesUrl = `${releaseRepositoryUrl}/releases`
const platformNames = new Map([
  ['darwin', 'macOS'],
  ['win32', 'Windows'],
  ['linux', 'Linux'],
])

type UpdateState = {
  info?: AppUpdateInstallation
  result?: AppUpdateCheck
  loading: boolean
  error?: string
}

function useUpdateCheck(reader: AppUpdateReader | undefined, connected = true) {
  const [state, setState] = useState<UpdateState>({ loading: Boolean(reader && connected) })
  const request = useRef(0)
  const load = useCallback(
    async (force: boolean) => {
      const id = ++request.current
      if (!reader) return
      setState((previous) => ({ ...previous, error: undefined, loading: true }))
      let info: AppUpdateInstallation | undefined
      try {
        info = await reader.getInfo()
        if (request.current !== id) return
        if (!info.checkEnabled) {
          setState({ info, loading: false })
          return
        }
        setState((previous) => ({ ...previous, info, loading: true }))
        const result = await reader.check(force)
        if (request.current === id) setState({ info, result, loading: false })
      } catch (cause) {
        if (request.current !== id) return
        const message = cause instanceof Error ? cause.message : String(cause)
        const error =
          cause instanceof TypeError ? '无法读取更新信息，请检查网络后重试。' : message || '检查失败，请稍后重试。'
        setState({ info, error, loading: false })
      }
    },
    [reader],
  )
  useEffect(() => {
    if (reader && connected) void load(false)
    else setState({ loading: false })
    return () => {
      request.current++
    }
  }, [reader, connected, load])
  return { ...state, retry: () => void load(true) }
}

function AvailableRelease({ result, info }: { result: AppUpdateCheck; info: AppUpdateInstallation }) {
  const { asset, version } = result
  const applicable = asset && asset.kind === info.kind && asset.platform === info.platform && asset.arch === info.arch
  const filename = applicable ? releaseAssetName(version, asset) : undefined
  const notes = result.notes.trim().split(/\n+/).filter(Boolean)
  const size = asset
    ? asset.size < 1024 ** 2
      ? `${Math.ceil(asset.size / 1024)} KiB`
      : `${(asset.size / 1024 ** 2).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} MiB`
    : undefined
  return (
    <div className="space-y-3 px-4 py-3">
      {notes.length > 0 && (
        <ul aria-label="更新亮点" className="list-disc space-y-1 pl-4 leading-relaxed break-words">
          {notes.map((note, index) => (
            <li key={index}>{note.replace(/^\s*[-*•]\s+/, '')}</li>
          ))}
        </ul>
      )}
      {applicable ? (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <a
              className={buttonVariants({ size: 'sm' })}
              href={releaseAssetUrl(version, asset)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {info.kind === 'docker' ? '下载镜像' : '下载安装包'}
            </a>
            <span className="text-muted-foreground">{size}</span>
            <a
              className="underline underline-offset-4"
              href={releaseTagUrl(version)}
              target="_blank"
              rel="noopener noreferrer"
            >
              发布说明
            </a>
          </div>
          {info.kind === 'docker' && (
            <div className="space-y-1 leading-relaxed text-muted-foreground">
              <p>在部署机器上加载镜像，将 Compose 的 PI_MEME_IMAGE 改为 pi-meme-host:{version} 后重建容器。</p>
              <code className="block break-all select-text">docker load -i {filename}</code>
            </div>
          )}
          <details className="text-muted-foreground">
            <summary className="w-fit cursor-pointer">文件与 SHA-256</summary>
            <div className="mt-2 space-y-1 font-mono break-all select-text">
              <p>{filename}</p>
              <p>{asset.sha256}</p>
            </div>
          </details>
        </>
      ) : (
        <p className="leading-relaxed text-muted-foreground">
          此版本没有适配当前系统和架构的安装包。{' '}
          <a
            className="underline underline-offset-4"
            href={releaseTagUrl(version)}
            target="_blank"
            rel="noopener noreferrer"
          >
            查看发布说明
          </a>
        </p>
      )}
    </div>
  )
}

function UpdateCard({
  title,
  state,
  disconnected = false,
  bundled = false,
  host = false,
}: {
  title: string
  state: ReturnType<typeof useUpdateCheck>
  disconnected?: boolean
  bundled?: boolean
  host?: boolean
}) {
  const { info, loading, error, result } = state
  const disabled = info?.checkEnabled === false
  const action = error || (host && disconnected) ? '重试' : '检查更新'
  let status: string | undefined
  if (error) status = error
  else if (loading) status = info ? '正在检查更新…' : '正在读取版本…'
  else if (result?.status === 'available') status = `发现新版本 v${result.version}`
  else if (result?.status === 'current') status = '已是最新稳定版'
  else if (result?.status === 'ahead') status = `当前安装领先于稳定版 v${result.version}`
  else if (disabled) status = info.development ? '开发构建默认关闭更新检查。' : '此安装已关闭更新检查。'
  else if (disconnected) status = '服务未连接，恢复连接后可检查更新。'
  return (
    <SettingsCard>
      <SettingsRow>
        <div className="min-w-0 flex-1 basis-36 space-y-1">
          <p className="break-words font-semibold">
            {title}
            {info && <span className="ml-2 font-mono font-normal select-text">v{info.version}</span>}
          </p>
          {info && (
            <p className="break-words text-muted-foreground">
              {[
                platformNames.get(info.platform) ?? info.platform,
                info.arch,
                ...(info.kind === 'docker' ? ['Docker'] : []),
                ...(bundled ? [disconnected ? '内置 Host 未连接' : '含内置 Host'] : []),
                ...(host && info.kind === 'desktop' ? ['随 Desktop 升级'] : []),
              ].join(' · ')}
            </p>
          )}
        </div>
        {!disabled && (
          <Button
            variant="outline"
            size="sm"
            className={settingsControlClassName}
            aria-label={`${title}：${action}`}
            disabled={loading}
            onClick={state.retry}
          >
            {loading ? '检查中…' : action}
          </Button>
        )}
      </SettingsRow>
      <div role="status" className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 leading-relaxed">
        <span className={error ? 'break-words text-destructive' : 'break-words text-muted-foreground'}>{status}</span>
        {error && (
          <a href={releasesUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
            查看发布页
          </a>
        )}
      </div>
      {info && result?.status === 'available' && <AvailableRelease result={result} info={info} />}
    </SettingsCard>
  )
}

function HostUpdate({ reader, label, connected }: { reader: AppUpdateReader; label: string; connected: boolean }) {
  const state = useUpdateCheck(reader, connected)
  return <UpdateCard title={`Host · ${label}`} state={state} disconnected={!connected} host />
}

export function AppUpdateSettings({
  desktop,
  host,
  hostId,
  hostLabel,
  hostLocal,
  connected,
}: {
  desktop?: AppUpdateReader
  host: AppUpdateReader
  hostId?: string
  hostLabel: string
  hostLocal: boolean
  connected: boolean
}) {
  const state = useUpdateCheck(desktop)
  const bundled = Boolean(hostLocal && hostId && state.info?.bundledHostId === hostId)
  const readingOwner = desktop && hostLocal && state.loading && !state.info
  return (
    <SettingsGroup title="Pi meme">
      {desktop && (
        <UpdateCard title="本机 Desktop" state={state} disconnected={bundled && !connected} bundled={bundled} />
      )}
      {!bundled && !readingOwner && (
        <HostUpdate key={connected ? 'connected' : 'offline'} reader={host} label={hostLabel} connected={connected} />
      )}
    </SettingsGroup>
  )
}
