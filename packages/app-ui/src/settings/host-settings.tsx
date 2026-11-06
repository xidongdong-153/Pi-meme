import { useEffect, useState } from 'react'
import { Monitor, Server } from 'lucide-react'
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { RevealContent } from '@pi-meme/ui/components/reveal-content'
import { Button } from '@pi-meme/ui/components/ui/button'
import { SettingsCard, SettingsGroup, SettingsRow, settingsControlClassName } from '@pi-meme/ui/components/settings'
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
      <SettingsCard>
        <SettingsRow className="justify-start">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary">
            <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
          </span>
          <div className="min-w-0">
            <h3 className="font-medium">{local ? '此计算机' : '远程'}</h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">当前设置和插件属于此执行服务。</p>
          </div>
        </SettingsRow>
        {!local && (
          <SettingsRow>
            <dl className="min-w-0 space-y-0.5">
              <dt className="font-medium">服务地址</dt>
              <dd className="break-all text-[11px] text-muted-foreground select-text">{address || '未提供'}</dd>
            </dl>
          </SettingsRow>
        )}
      </SettingsCard>
      <RevealContent ready={saved.length > 0 && Boolean(connections)}>
        {connections && (
          <SettingsGroup title="已保存的远程">
            <SettingsCard>
              {saved.map((entry) => (
                <SettingsRow key={entry.url}>
                  <span className="min-w-0 flex-1 basis-48 break-all">{entry.url}</span>
                  <Button
                    variant="secondary"
                    className={settingsControlClassName}
                    disabled={busy}
                    onClick={() => void run(() => connections.connect(entry.url))}
                  >
                    连接
                  </Button>
                  <Button
                    variant="ghost"
                    className={settingsControlClassName}
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
                </SettingsRow>
              ))}
            </SettingsCard>
          </SettingsGroup>
        )}
      </RevealContent>
      <Button variant="outline" className={settingsControlClassName} disabled={busy} onClick={onConnect}>
        <Server />
        配置远程服务
      </Button>
      <RevealContent ready={canImport}>
        <SettingsGroup title="旧钥匙串凭据">
          <SettingsCard className="space-y-3 divide-y-0 p-4">
            <p className="text-[11px] text-muted-foreground">
              主动导入时可能需要输入系统密码；auth.json 中已有的凭据会保留。
            </p>
            <Button
              variant="secondary"
              className={settingsControlClassName}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await call<CredentialImportResult>('host:import-keychain')
                  setNotice(
                    `已导入 ${result.imported} 项，保留已有 ${result.skipped} 项。${result.reconnectError ?? ''}`,
                  )
                })
              }
            >
              导入旧钥匙串凭据
            </Button>
          </SettingsCard>
        </SettingsGroup>
      </RevealContent>
      {error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          <CrossfadeText>{notice}</CrossfadeText>
        </p>
      )}
    </div>
  )
}
