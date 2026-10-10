import { Monitor, Server } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'

export function HostSettings({
  hostId,
  address,
  local,
  onConnect,
}: {
  hostId?: string
  address?: string
  local: boolean
  onConnect: () => void
}) {
  const Icon = local ? Monitor : Server
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-card p-6">
        <div className="flex items-center gap-4">
          <span className="flex size-12 items-center justify-center rounded-xl bg-secondary">
            <Icon className="size-6 text-muted-foreground" />
          </span>
          <div>
            <h3 className="text-base font-medium">{local ? '本地主机' : '远程 Host'}</h3>
            <p className="mt-1 text-sm text-muted-foreground">当前设置和插件属于这台 Host。</p>
          </div>
        </div>
        <dl className="mt-6 space-y-4 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Host 地址</dt>
            <dd className="mt-1 break-all select-text">{address || '未提供'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Host 身份</dt>
            <dd className="mt-1 break-all font-mono text-xs select-text">{hostId || '尚未连接'}</dd>
          </div>
        </dl>
      </section>
      <Button variant="secondary" onClick={onConnect}>
        <Server />
        连接其他 Host
      </Button>
    </div>
  )
}
