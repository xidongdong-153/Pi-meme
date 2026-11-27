import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Box, Download, RefreshCw, Server } from 'lucide-react'
import {
  releaseAssetName,
  releaseAssetUrl,
  releaseRepositoryUrl,
  releaseTagUrl,
  type AppUpdateCheck,
  type AppUpdateInstallation,
  type AppUpdateReader,
} from '@pi-meme/contracts/app-update'
import { BrandMark } from '@pi-meme/ui/components/brand-mark'
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { RevealContent } from '@pi-meme/ui/components/reveal-content'
import { SettingsCard, settingsControlClassName } from '@pi-meme/ui/components/settings'
import { Button, buttonVariants } from '@pi-meme/ui/components/ui/button'
import { cn } from '@pi-meme/ui/lib/utils'

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
        setState((previous) => ({ info: info ?? previous.info, error, loading: false }))
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

function formatSize(bytes: number) {
  return bytes < 1024 ** 2
    ? `${Math.ceil(bytes / 1024)} KiB`
    : `${(bytes / 1024 ** 2).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} MiB`
}

function AvailableRelease({ result, info }: { result: AppUpdateCheck; info: AppUpdateInstallation }) {
  const { asset, version } = result
  const applicable = asset && asset.kind === info.kind && asset.platform === info.platform && asset.arch === info.arch
  const filename = applicable ? releaseAssetName(version, asset) : undefined
  const notes = result.notes
    .trim()
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-*•]\s+/, '').trim())
    .filter(Boolean)

  return (
    <div className="space-y-3 border-t border-border/60 bg-primary/[0.04] px-4 py-3.5 sm:px-5">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs font-semibold text-foreground select-text">v{version}</span>
        <span className="text-[11px] text-muted-foreground">新版本可用</span>
      </div>
      {notes.length === 1 && <p className="leading-relaxed break-words text-foreground/85">{notes[0]}</p>}
      {notes.length > 1 && (
        <ul aria-label="更新亮点" className="space-y-1.5 leading-relaxed break-words text-foreground/85">
          {notes.map((note, index) => (
            <li key={index} className="flex gap-2">
              <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-primary" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      )}
      {applicable && info.kind === 'docker' && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          下载后执行 <code className="font-mono break-all text-foreground select-text">docker load -i {filename}</code>
          ，并将 <code className="font-mono text-foreground">PI_MEME_IMAGE</code> 改为{' '}
          <code className="font-mono text-foreground select-text">pi-meme-host:{version}</code> 后重建容器。
        </p>
      )}
      {applicable ? (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-0.5">
          <div className="flex flex-wrap items-center gap-3">
            <a
              className={cn(buttonVariants({ size: 'sm' }), settingsControlClassName, 'gap-1.5 px-3.5')}
              href={releaseAssetUrl(version, asset)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Download aria-hidden="true" className="size-3.5" />
              <span>{info.kind === 'docker' ? '下载镜像' : '下载更新'}</span>
            </a>
            <span className="text-[11px] text-muted-foreground">{formatSize(asset.size)}</span>
          </div>
          <a
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground hover:underline underline-offset-4"
            href={releaseTagUrl(version)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>发布说明</span>
            <ArrowUpRight aria-hidden="true" className="size-3" />
          </a>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-0.5">
          <span className="text-[11px] text-muted-foreground">此版本暂无适配当前系统和架构的安装包</span>
          <a
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), settingsControlClassName, 'gap-1.5')}
            href={releaseTagUrl(version)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>查看发布页</span>
            <ArrowUpRight aria-hidden="true" className="size-3" />
          </a>
        </div>
      )}
    </div>
  )
}

function UpdateCard({
  title,
  state,
  primary = false,
  disconnected = false,
  bundled = false,
  host = false,
}: {
  title: string
  state: ReturnType<typeof useUpdateCheck>
  primary?: boolean
  disconnected?: boolean
  bundled?: boolean
  host?: boolean
}) {
  const { info, loading, error, result } = state
  const disabled = info?.checkEnabled === false
  const hasUpdate = Boolean(info && result?.status === 'available' && !error)
  const action = error || (host && disconnected) ? '重试' : hasUpdate ? '重新检查' : '检查更新'

  let dotClass = 'bg-muted-foreground/50'
  let textClass = 'text-muted-foreground'
  let status = ''
  const initialLoading = loading && !result && !error

  if (error) {
    dotClass = 'bg-destructive'
    textClass = 'text-destructive'
    status = error
  } else if (initialLoading) {
    status = info ? '正在检查更新…' : '正在读取版本…'
  } else if (result?.status === 'available') {
    dotClass = 'bg-primary'
    textClass = 'font-medium text-primary'
    status = `有新版本 v${result.version}`
  } else if (result?.status === 'current') {
    dotClass = 'bg-emerald-500'
    status = '已是最新稳定版'
  } else if (result?.status === 'ahead') {
    dotClass = 'bg-amber-500'
    status = `领先于稳定版 v${result.version}`
  } else if (disabled) {
    status = info.development ? '开发构建默认关闭更新检查' : '此安装已关闭更新检查'
  } else if (disconnected) {
    dotClass = 'bg-amber-500'
    status = '服务未连接，恢复连接后可检查更新'
  }

  const env = info
    ? [
        platformNames.get(info.platform) ?? info.platform,
        info.arch,
        ...(info.kind === 'docker' ? ['Docker'] : []),
        ...(bundled ? [disconnected ? '内置 Host 未连接' : '含内置 Host'] : []),
        ...(host && info.kind === 'desktop' ? ['随 Desktop 升级'] : []),
      ].join(' · ')
    : ''

  const HostIcon = info?.kind === 'docker' ? Box : Server

  return (
    <SettingsCard className="divide-y-0" aria-busy={loading}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
        <div className="flex min-w-0 flex-1 basis-52 items-center gap-3.5">
          {primary ? (
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-secondary/50">
              <BrandMark size={28} />
            </span>
          ) : (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-secondary/50 text-muted-foreground">
              <HostIcon aria-hidden="true" className="size-4" />
            </span>
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <p className={cn('break-words font-semibold tracking-tight', primary ? 'text-[15px]' : 'text-[13px]')}>
                {title}
              </p>
              {info && <span className="font-mono text-xs text-muted-foreground select-text">v{info.version}</span>}
            </div>
            <div className="flex min-h-4 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px]">
              {status && (
                <span
                  role={error ? 'alert' : 'status'}
                  className={cn(
                    'inline-flex min-w-0 items-center gap-1.5 break-words',
                    textClass,
                    initialLoading && 'ui-loading-delayed',
                  )}
                >
                  <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', dotClass)} />
                  <CrossfadeText>{status}</CrossfadeText>
                </span>
              )}
              {status && env && (
                <span aria-hidden="true" className="text-muted-foreground/50">
                  ·
                </span>
              )}
              {env && <span className="break-words text-muted-foreground">{env}</span>}
            </div>
          </div>
        </div>
        {!disabled && (
          <Button
            variant={hasUpdate ? 'ghost' : 'outline'}
            size="sm"
            className={cn(
              settingsControlClassName,
              'shrink-0 gap-1.5',
              hasUpdate && 'px-2.5 text-muted-foreground hover:text-foreground',
            )}
            aria-label={`${title}：${action}`}
            disabled={loading}
            onClick={state.retry}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn('size-3.5', loading && 'animate-spin motion-reduce:animate-none')}
            />
            <span>{loading ? '检查中…' : action}</span>
          </Button>
        )}
      </div>
      <RevealContent ready={Boolean(error)}>
        {error && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 bg-destructive/[0.05] px-4 py-2 text-[11px] text-muted-foreground sm:px-5">
            <span>也可以直接在发布页查看最新版本</span>
            <a
              href={releasesUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-1 text-foreground hover:underline underline-offset-4"
            >
              <span>查看发布页</span>
              <ArrowUpRight aria-hidden="true" className="size-3" />
            </a>
          </div>
        )}
      </RevealContent>
      <RevealContent ready={hasUpdate}>
        {info && result?.status === 'available' && <AvailableRelease result={result} info={info} />}
      </RevealContent>
    </SettingsCard>
  )
}

function HostUpdate({
  reader,
  label,
  connected,
  primary = false,
}: {
  reader: AppUpdateReader
  label: string
  connected: boolean
  primary?: boolean
}) {
  const state = useUpdateCheck(reader, connected)
  const title = primary ? (label === '当前服务' ? 'Pi meme' : `Pi meme · ${label}`) : `Host · ${label}`
  return <UpdateCard title={title} state={state} primary={primary} disconnected={!connected} host />
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
  const desktopTitle = bundled || readingOwner ? 'Pi meme' : 'Pi meme Desktop'
  return (
    <section aria-label="Pi meme 更新" className="min-w-0 space-y-3">
      {desktop && (
        <UpdateCard title={desktopTitle} state={state} primary disconnected={bundled && !connected} bundled={bundled} />
      )}
      {!bundled && !readingOwner && (
        <HostUpdate
          key={connected ? 'connected' : 'offline'}
          reader={host}
          label={hostLabel}
          connected={connected}
          primary={!desktop}
        />
      )}
    </section>
  )
}
