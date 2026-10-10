import { useEffect, useState } from 'react'
import { Monitor, Server } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import type { CredentialImportResult, SavedHostConnection } from '@pi-meme/contracts/host'

export function HostSettings({
  address,
  local,
  onConnect,
  connections,
  call,
}: {
  hostId?: string
  address?: string
  local: boolean
  onConnect: () => void
  connections?: {
    list: () => Promise<SavedHostConnection[]>
    connect: (url: string) => Promise<void>
    remove: (url: string) => Promise<void>
  }
  call: <T>(method: string, args?: unknown[]) => Promise<T>
}) {
  const [saved, setSaved] = useState<SavedHostConnection[]>([])
  const [canImport, setCanImport] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const list = connections?.list
  useEffect(() => {
    let active = true
    void Promise.all([
      list ? list() : Promise.resolve([]),
      local ? call<{ available: boolean }>('host:credential-import-status') : Promise.resolve({ available: false }),
    ])
      .then(([profiles, status]) => {
        if (!active) return
        setSaved(profiles)
        setCanImport(status.available)
      })
      .catch((cause: unknown) => {
        if (active) setError(String(cause))
      })
    return () => {
      active = false
    }
  }, [list, local, call])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const Icon = local ? Monitor : Server
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-card p-6">
        <div className="flex items-center gap-4">
          <span className="flex size-12 items-center justify-center rounded-xl bg-secondary">
            <Icon className="size-6 text-muted-foreground" />
          </span>
          <div>
            <h3 className="text-base font-medium">{local ? '此计算机' : '远程'}</h3>
            <p className="mt-1 text-sm text-muted-foreground">当前设置和插件属于此执行服务。</p>
          </div>
        </div>
        {!local && (
          <dl className="mt-6 space-y-4 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">服务地址</dt>
              <dd className="mt-1 break-all select-text">{address || '未提供'}</dd>
            </div>
          </dl>
        )}
      </section>
      {saved.length > 0 && connections && (
        <section className="space-y-3" aria-label="已保存的远程">
          <h3 className="text-sm font-medium">已保存的远程</h3>
          {saved.map((entry) => (
            <div key={entry.url} className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-4">
              <span className="min-w-0 flex-1 break-all text-sm">{entry.url}</span>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void run(() => connections.connect(entry.url))}
              >
                连接
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await connections.remove(entry.url)
                    setSaved(await connections.list())
                  })
                }
              >
                移除
              </Button>
            </div>
          ))}
        </section>
      )}
      <Button variant="secondary" disabled={busy} onClick={onConnect}>
        <Server />
        配置远程服务
      </Button>
      {canImport && (
        <section className="space-y-3 rounded-xl border border-border p-4">
          <h3 className="text-sm font-medium">旧钥匙串凭据</h3>
          <p className="text-sm text-muted-foreground">
            主动导入时可能需要输入系统密码；auth.json 中已有的凭据会保留。
          </p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await call<CredentialImportResult>('host:import-keychain')
                setNotice(`已导入 ${result.imported} 项，保留已有 ${result.skipped} 项。${result.reconnectError ?? ''}`)
              })
            }
          >
            导入旧钥匙串凭据
          </Button>
        </section>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  )
}
