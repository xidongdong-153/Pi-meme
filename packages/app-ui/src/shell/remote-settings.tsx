import { useState } from 'react'
import type { HostService } from '@pi-meme/contracts/host'
import type { ServiceRegistry } from './service-ui'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { serviceAddress } from './service-ui'

export function RemoteSettings({
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
      <p className="text-sm text-muted-foreground">远程连接由此计算机管理。项目、对话和执行设置保存在各自服务。</p>
      {services
        .filter((service) => !service.local)
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
