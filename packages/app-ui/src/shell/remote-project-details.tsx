import { useEffect, useState } from 'react'
import { CircleAlert, Copy, Folder, Globe, Loader2, Pin, PinOff, RefreshCw } from 'lucide-react'
import type { HostService } from '@pi-meme/contracts/host'
import type { PiProjectGroup } from '@pi-meme/contracts/sessions'
import { Button } from '@pi-meme/ui/components/ui/button'
import { serviceLabel, servicePaused, serviceStatus, type ServiceRegistry } from './service-ui'

export function RemoteProjectDetails({
  service,
  project,
  pinned,
  registry,
  onTogglePin,
}: {
  service: HostService
  project: PiProjectGroup
  pinned: boolean
  registry: ServiceRegistry
  onTogglePin: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [canManage, setCanManage] = useState(service.transport !== 'ssh')
  useEffect(() => {
    if (service.transport !== 'ssh') return
    let current = true
    void registry.ssh
      .capabilities()
      .then((value) => {
        if (current) setCanManage(value.canManage)
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [registry, service.transport])
  const retry = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (service.transport === 'ssh') {
        if (servicePaused(service)) await registry.ssh.setEnabled(service.id, true)
        else await registry.ssh.retry(service.id)
      } else await registry.retry(service.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const offline = service.status !== 'connected'
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <Folder className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
        <button
          type="button"
          aria-label={`${pinned ? '取消置顶' : '置顶'}远程项目：${project.name}`}
          disabled={offline}
          onClick={onTogglePin}
          className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </button>
      </div>
      <div className="flex items-start gap-2 text-muted-foreground">
        <Globe className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <span className="break-words">
          {serviceLabel(service)} · {service.transport === 'ssh' ? 'SSH' : 'HTTPS'} · {project.sessionCount} 次聊天
        </span>
      </div>
      <div className="flex items-start gap-2 border-t border-border pt-2">
        {offline && <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
        <div className="min-w-0 flex-1 space-y-1">
          <p>{serviceStatus(service)}</p>
          {service.error && <p className="break-words text-muted-foreground">{service.error}</p>}
          {offline && (
            <p className="text-muted-foreground">列表和任务状态来自上次同步，远端任务不会随连接断开而停止。</p>
          )}
        </div>
        {offline && canManage && (
          <Button
            size="icon"
            variant="ghost"
            disabled={busy || service.phase === 'connecting'}
            aria-label={`${servicePaused(service) ? '恢复' : '重试'}连接：${serviceLabel(service)}`}
            onClick={() => void retry()}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
        )}
      </div>
      {offline && !canManage && <p className="text-muted-foreground">请在本机应用中管理连接。</p>}
      <div className="flex items-start gap-2 text-muted-foreground">
        <Folder className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 break-all">{project.cwd}</span>
        <button
          type="button"
          aria-label="复制远程项目路径"
          className="rounded p-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            void navigator.clipboard.writeText(project.cwd).catch(() => setError('复制失败，请手动选择路径复制'))
          }}
        >
          <Copy className="size-3" />
        </button>
      </div>
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
