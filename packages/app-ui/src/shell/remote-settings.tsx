import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Globe, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { HostService } from '@pi-meme/contracts/host'
import type { SshCapabilities, SshConnection } from '@pi-meme/contracts/ssh-connections'
import type { ServiceRegistry } from './service-ui'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
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
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">连接由入口 Host 管理。项目、对话和执行设置保存在各自服务。</p>
      <div role="tablist" aria-label="远程连接方式" className="inline-flex gap-1 rounded-lg bg-secondary/50 p-1">
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
              'rounded-md px-4 py-1.5 text-sm text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tab === value && 'bg-secondary text-foreground',
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
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`}>
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
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        添加后优先连接远端已有 Host，未发现时才自动安装并启动。SSH 配置、agent 和身份文件来自入口 Host。
      </p>
      {!capabilities && !loadError && (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取连接权限…
        </p>
      )}
      {capabilities && !capabilities.canManage && (
        <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
          {capabilities.reason || 'SSH 连接只能从入口 Host 的已认证本机页面管理。已登记的远程服务仍可使用。'}
        </p>
      )}
      {capabilities?.canManage && (
        <>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">SSH 连接</h3>
            <Button size="sm" disabled={!capabilities.available} onClick={() => setDialog({})}>
              <Plus aria-hidden="true" className="mr-1 size-3.5" />
              添加
            </Button>
          </div>
          {!capabilities.available && (
            <p className="text-sm text-muted-foreground">{capabilities.reason || '入口 Host 暂时无法启动系统 SSH。'}</p>
          )}
          {!profiles.length && !loadError && (
            <p className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">
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
                className="space-y-2 rounded-xl border border-border bg-card/40 p-4"
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
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Globe aria-hidden="true" className="size-4 shrink-0 text-primary" />
                      <span className="truncate" title={profile.name}>
                        {profile.name}
                      </span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground" title={profile.target}>
                      {profile.target}
                      {profile.port ? ` · SSH 端口 ${profile.port}` : ''}
                    </p>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                      {transitioning && <Loader2 aria-hidden="true" className="size-3 animate-spin" />}
                      {sshConnectionStatus(profile)}
                      {profile.phase === 'retrying' && profile.nextRetryAt && (
                        <span>· 下次尝试 {new Date(profile.nextRetryAt).toLocaleTimeString()}</span>
                      )}
                    </p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="ghost" aria-label={`管理 ${profile.name}`} disabled={busy}>
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
        </>
      )}
      {capabilities &&
        !capabilities.canManage &&
        sshServices.map((service) => (
          <section key={service.id} className="flex items-center gap-2 rounded-xl border border-border p-4 text-sm">
            <Globe aria-hidden="true" className="size-4 text-primary" />
            <span className="min-w-0 flex-1 truncate">{service.name || 'SSH 远程服务'}</span>
            <span className="text-xs text-muted-foreground">{serviceStatus(service)}</span>
          </section>
        ))}
      {loadError && (
        <div className="space-y-2">
          <p role="alert" className="break-words text-sm text-destructive">
            {loadError}
          </p>
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>
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
          <DialogTitle>移除 SSH 连接？</DialogTitle>
          <DialogDescription>
            删除入口 Host 保存的“{removing?.name}”连接资料和摘要。不会删除远端项目或会话，也不会停止远端任务。
          </DialogDescription>
          {removing && errors[removing.id] && (
            <p role="alert" className="text-sm text-destructive">
              {errors[removing.id]}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={pending.has(removing?.id ?? '')} onClick={() => setRemoving(undefined)}>
              取消
            </Button>
            <Button
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
              {pending.has(removing?.id ?? '') ? '移除中…' : '移除'}
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
    <div className="space-y-4">
      {services
        .filter((service) => !service.local && service.transport !== 'ssh')
        .map((service) => (
          <section key={service.id} className="space-y-2 rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 break-all text-sm">{serviceAddress(service.address)}</span>
              <span className="text-xs text-muted-foreground">
                {service.status === 'connected' ? '已连接' : service.status === 'connecting' ? '连接中' : '未连接'}
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void run(() => registry.retry(service.id))}
              >
                重试
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => onRemove(service.id))}>
                移除
              </Button>
            </div>
            {service.error && <p className="break-words text-xs text-destructive">{service.error}</p>}
          </section>
        ))}
      <Button
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
        <p role="alert" className="break-words text-sm text-destructive">
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
          <DialogTitle>配置远程服务</DialogTitle>
          <DialogDescription>填写服务地址和访问令牌，添加后可在工作位置中选择项目。</DialogDescription>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                await registry.register({ url, token })
                setToken('')
                setOpen(false)
              })
            }}
          >
            <label className="block space-y-2 text-sm">
              服务地址
              <Input
                aria-label="远程服务地址"
                placeholder="https://example.com"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                required
              />
            </label>
            <label className="block space-y-2 text-sm">
              访问令牌
              <Input
                aria-label="远程访问令牌"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? '连接中' : '连接'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
