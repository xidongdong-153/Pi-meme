import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Globe, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { HostService } from '@pi-meme/contracts/host'
import type { SshCapabilities, SshConnection } from '@pi-meme/contracts/ssh-connections'
import type { ServiceRegistry } from './service-ui'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { RevealContent } from '@pi-meme/ui/components/reveal-content'
import { Button } from '@pi-meme/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import { settingsCardClassName, settingsControlClassName } from '@pi-meme/ui/components/settings'
import { cn } from '@pi-meme/ui/lib/utils'
import { serviceAddress, serviceStatus, sshConnectionStatus } from './service-ui'
import { SshConnectionDialog } from './ssh-connection-dialog'

export function RemoteSettings({
  services,
  registry,
  onRemove,
}: {
  services: HostService[]
  registry: ServiceRegistry
  onRemove: (id: string) => Promise<void>
}) {
  const [tab, setTab] = useState<'https' | 'ssh'>('ssh')
  const tabsId = useId()
  return (
    <div className="min-w-0 space-y-6">
      <div role="tablist" aria-label="远程连接方式" className="inline-flex max-w-full flex-wrap items-center gap-1">
        {(['ssh', 'https'] as const).map((value) => (
          <button
            key={value}
            id={`${tabsId}-${value}`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`${tabsId}-panel`}
            tabIndex={tab === value ? 0 : -1}
            data-tab={value}
            className={cn(
              'h-8 rounded-lg px-3 text-xs text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tab === value && 'bg-secondary font-medium text-foreground',
            )}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next =
                event.key === 'Home' ? 'ssh' : event.key === 'End' ? 'https' : tab === 'https' ? 'ssh' : 'https'
              setTab(next)
              event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
            }}
          >
            {value.toUpperCase()}
          </button>
        ))}
      </div>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`} className="min-w-0">
        {tab === 'https' ? (
          <HttpsSettings services={services} registry={registry} onRemove={onRemove} />
        ) : (
          <SshSettings services={services} registry={registry} onRemove={onRemove} />
        )}
      </div>
    </div>
  )
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

function SshSettings({
  services,
  registry,
  onRemove,
}: {
  services: HostService[]
  registry: ServiceRegistry
  onRemove: (id: string) => Promise<void>
}) {
  const [capabilities, setCapabilities] = useState<SshCapabilities>()
  const [profiles, setProfiles] = useState<SshConnection[]>([])
  const [profilesReady, setProfilesReady] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const pendingRef = useRef(new Set<string>())
  const revision = useRef(0)
  const [dialog, setDialog] = useState<{ connection?: SshConnection }>()
  const [removing, setRemoving] = useState<SshConnection>()

  const refresh = useCallback(async () => {
    const current = ++revision.current
    try {
      const next = await registry.ssh.capabilities()
      if (current !== revision.current) return
      setCapabilities(next)
      if (!next.canManage) {
        setProfiles([])
        setLoadError('')
        return
      }
      const list = await registry.ssh.list()
      if (current !== revision.current) return
      setProfiles([...list])
      setProfilesReady(true)
      setLoadError('')
    } catch (cause) {
      if (current === revision.current) setLoadError(errorMessage(cause))
    }
  }, [registry])

  useEffect(() => {
    void refresh()
    const unsubscribe = registry.subscribe(() => void refresh())
    return () => {
      revision.current++
      unsubscribe()
    }
  }, [registry, refresh])

  async function perform(id: string, work: () => Promise<unknown>) {
    if (pendingRef.current.has(id)) return false
    pendingRef.current.add(id)
    setPending(new Set(pendingRef.current))
    setErrors((previous) => ({ ...previous, [id]: '' }))
    try {
      await work()
      await refresh()
      return true
    } catch (cause) {
      setErrors((previous) => ({ ...previous, [id]: errorMessage(cause) }))
      return false
    } finally {
      pendingRef.current.delete(id)
      setPending(new Set(pendingRef.current))
    }
  }

  const sshServices = services.filter((service) => service.transport === 'ssh')
  return (
    <div className="min-w-0 space-y-6">
      <p className="text-[11px] leading-relaxed text-muted-foreground">使用 SSH 连接远程设备。</p>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-muted-foreground">SSH 连接</h3>
        <Button
          className={settingsControlClassName}
          size="sm"
          disabled={!capabilities?.canManage || !capabilities.available}
          onClick={() => setDialog({})}
        >
          <Plus aria-hidden="true" className="mr-1 size-3.5" />
          添加
        </Button>
      </div>
      {capabilities && !capabilities.canManage && (
        <p className={cn(settingsCardClassName, 'px-4 py-3 text-[11px] leading-relaxed text-muted-foreground')}>
          {capabilities.reason || '请在本机应用中管理 SSH 连接。'}
        </p>
      )}
      <RevealContent ready={Boolean(capabilities?.canManage && profilesReady)}>
        {capabilities?.canManage && (
          <div className="min-w-0 space-y-3">
            {!capabilities.available && (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {capabilities.reason || '无法启动 SSH，请检查系统是否已安装 OpenSSH。'}
              </p>
            )}
            {!profiles.length && !loadError && (
              <p
                className={cn(
                  settingsCardClassName,
                  'border-dashed px-4 py-3 text-[11px] leading-relaxed text-muted-foreground',
                )}
              >
                还没有 SSH 连接。从 SSH 配置选择主机，或手动填写连接资料。
              </p>
            )}
            {profiles.map((profile) => {
              const busy = pending.has(profile.id)
              const transitioning = profile.phase === 'connecting' || profile.phase === 'retrying'
              return (
                <section
                  key={profile.id}
                  aria-label={`SSH 连接 ${profile.name}`}
                  className={cn(settingsCardClassName, 'space-y-2 divide-y-0 px-4 py-3')}
                >
                  <div className="flex items-center gap-3">
                    <Switch
                      label={`保持连接 ${profile.name}`}
                      checked={profile.enabled}
                      disabled={busy || (!capabilities.available && !profile.enabled)}
                      onChange={(enabled) => {
                        void perform(profile.id, () => registry.ssh.setEnabled(profile.id, enabled))
                      }}
                    />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
                        <Globe aria-hidden="true" className="size-4 shrink-0 text-primary" />
                        <span className="min-w-0 [overflow-wrap:anywhere]" title={profile.name}>
                          {profile.name}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground [overflow-wrap:anywhere]" title={profile.target}>
                        {profile.target}
                        {profile.port ? ` · SSH 端口 ${profile.port}` : ''}
                      </p>
                      <p
                        className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground [overflow-wrap:anywhere]"
                        role="status"
                      >
                        {transitioning && <Loader2 aria-hidden="true" className="size-3 shrink-0 animate-spin" />}
                        <CrossfadeText className="min-w-0">{sshConnectionStatus(profile)}</CrossfadeText>
                        {profile.phase === 'retrying' && profile.nextRetryAt && (
                          <span>· 下次尝试 {new Date(profile.nextRetryAt).toLocaleTimeString()}</span>
                        )}
                      </p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          className={settingsControlClassName}
                          size="icon"
                          variant="ghost"
                          aria-label={`管理 ${profile.name}`}
                          disabled={busy}
                        >
                          <MoreHorizontal aria-hidden="true" className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="bottom" align="end">
                        <DropdownMenuItem onSelect={() => setDialog({ connection: profile })}>
                          <Pencil />
                          编辑
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!capabilities.available || !profile.enabled || profile.phase === 'connecting'}
                          onSelect={() => void perform(profile.id, () => registry.ssh.retry(profile.id))}
                        >
                          <RefreshCw />
                          立即重试
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive" onSelect={() => setRemoving(profile)}>
                          <Trash2 />
                          移除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {profile.error && <p className="break-words text-xs text-destructive">{profile.error}</p>}
                  {errors[profile.id] && (
                    <p role="alert" className="break-words text-xs text-destructive">
                      {errors[profile.id]}
                    </p>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </RevealContent>
      {capabilities &&
        !capabilities.canManage &&
        sshServices.map((service) => (
          <section
            key={service.id}
            className={cn(settingsCardClassName, 'flex flex-wrap items-center gap-3 divide-y-0 px-4 py-3')}
          >
            <Globe aria-hidden="true" className="size-4 text-primary" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{service.name || 'SSH 远程服务'}</span>
            <CrossfadeText className="text-[11px] leading-relaxed text-muted-foreground">
              {serviceStatus(service)}
            </CrossfadeText>
          </section>
        ))}
      {loadError && (
        <div className="space-y-2">
          <p role="alert" className="break-words text-xs text-destructive">
            {loadError}
          </p>
          <Button className={settingsControlClassName} size="sm" variant="secondary" onClick={() => void refresh()}>
            重新读取
          </Button>
        </div>
      )}
      {dialog && capabilities?.canManage && (
        <SshConnectionDialog
          key={dialog.connection?.id ?? 'new'}
          ssh={registry.ssh}
          profiles={profiles}
          connection={dialog.connection}
          onSaved={refresh}
          onClose={() => setDialog(undefined)}
        />
      )}
      <Dialog
        open={Boolean(removing) && Boolean(capabilities?.canManage)}
        onOpenChange={(open) => !open && !pending.has(removing?.id ?? '') && setRemoving(undefined)}
      >
        <DialogContent>
          <DialogTitle className="text-base">移除 SSH 连接？</DialogTitle>
          <DialogDescription className="text-[11px] leading-relaxed [overflow-wrap:anywhere]">
            删除“{removing?.name}”的连接记录？远程项目、会话和运行中的任务不受影响。
          </DialogDescription>
          {removing && errors[removing.id] && (
            <p role="alert" className="text-xs text-destructive">
              {errors[removing.id]}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              className={settingsControlClassName}
              variant="outline"
              disabled={pending.has(removing?.id ?? '')}
              onClick={() => setRemoving(undefined)}
            >
              取消
            </Button>
            <Button
              className={settingsControlClassName}
              disabled={pending.has(removing?.id ?? '')}
              onClick={() => {
                if (!removing) return
                const profile = removing
                void perform(profile.id, () =>
                  profile.hostId ? onRemove(profile.id) : registry.ssh.remove(profile.id),
                ).then((removed) => {
                  if (removed) setRemoving(undefined)
                })
              }}
            >
              <CrossfadeText reserve={['移除中…', '移除']}>
                {pending.has(removing?.id ?? '') ? '移除中…' : '移除'}
              </CrossfadeText>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function HttpsSettings({
  services,
  registry,
  onRemove,
}: {
  services: HostService[]
  registry: ServiceRegistry
  onRemove: (id: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function run(work: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="min-w-0 space-y-6">
      {services
        .filter((service) => !service.local && service.transport !== 'ssh')
        .map((service) => (
          <section key={service.id} className={cn(settingsCardClassName, 'space-y-2 divide-y-0 px-4 py-3')}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 basis-48 break-all text-xs font-medium">
                {serviceAddress(service.address)}
              </span>
              <span className="text-[11px] leading-relaxed text-muted-foreground">
                <CrossfadeText reserve={['已连接', '连接中', '未连接']}>
                  {service.status === 'connected' ? '已连接' : service.status === 'connecting' ? '连接中' : '未连接'}
                </CrossfadeText>
              </span>
              <Button
                className={settingsControlClassName}
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void run(() => registry.retry(service.id))}
              >
                重试
              </Button>
              <Button
                className={settingsControlClassName}
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void run(() => onRemove(service.id))}
              >
                移除
              </Button>
            </div>
            {service.error && <p className="break-words text-xs text-destructive">{service.error}</p>}
          </section>
        ))}
      <Button
        className={settingsControlClassName}
        onClick={() => {
          setUrl('')
          setToken('')
          setError('')
          setOpen(true)
        }}
      >
        配置远程服务
      </Button>
      {error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value)
        }}
      >
        <DialogContent>
          <DialogTitle className="text-base">配置远程服务</DialogTitle>
          <DialogDescription className="text-[11px] leading-relaxed [overflow-wrap:anywhere]">
            填写服务地址和访问令牌，添加后可在工作位置中选择项目。
          </DialogDescription>
          <form
            className={cn(settingsCardClassName, 'space-y-4 divide-y-0 p-4')}
            onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                await registry.register({ url, token })
                setToken('')
                setOpen(false)
              })
            }}
          >
            <label className="block min-w-0 space-y-2 text-xs font-medium">
              服务地址
              <Input
                className={settingsControlClassName}
                aria-label="远程服务地址"
                placeholder="https://example.com"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                required
              />
            </label>
            <label className="block min-w-0 space-y-2 text-xs font-medium">
              访问令牌
              <Input
                className={settingsControlClassName}
                aria-label="远程访问令牌"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="break-words text-xs text-destructive">
                {error}
              </p>
            )}
            <Button className={settingsControlClassName} type="submit" disabled={busy}>
              <CrossfadeText reserve={['连接中', '连接']}>{busy ? '连接中' : '连接'}</CrossfadeText>
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
