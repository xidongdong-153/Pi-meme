import { useEffect, useState } from 'react'
import type {
  BrowserPermission,
  BrowserPlatform,
  BrowserSettings as Preferences,
  BrowserSnapshot,
} from '@pi-meme/contracts/browser'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'

const permissionNames: Record<string, string> = {
  media: '摄像头与麦克风',
  geolocation: '位置',
  'clipboard-read': '读取剪贴板',
  notifications: '通知',
  fullscreen: '全屏',
}
export function BrowserSettings({ platform, onOpen }: { platform?: BrowserPlatform; onOpen: (url: string) => void }) {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>()
  const [section, setSection] = useState<'general' | 'history' | 'downloads' | 'permissions'>('general')
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [parts, setParts] = useState<Array<'history' | 'storage' | 'cache' | 'downloads'>>(['cache'])
  const [origin, setOrigin] = useState('')
  const [permission, setPermission] = useState('media')
  const [grant, setGrant] = useState<BrowserPermission['value']>('ask')
  useEffect(() => {
    if (!platform) return
    let cancelled = false
    const refresh = () => {
      void platform
        .snapshot()
        .then((value) => {
          if (!cancelled) setSnapshot(value)
        })
        .catch((cause) => {
          if (!cancelled) setError(String(cause))
        })
    }
    refresh()
    const release = platform.onEvent((event) => {
      if (event.type === 'changed') refresh()
    })
    return () => {
      cancelled = true
      release()
    }
  }, [platform])
  const run = async (action: () => Promise<unknown>) => {
    setSaving(true)
    setError('')
    try {
      await action()
      if (platform) setSnapshot(await platform.snapshot())
    } catch (cause) {
      setError(String(cause))
    } finally {
      setSaving(false)
    }
  }
  if (!platform)
    return (
      <p className="p-6 text-sm text-muted-foreground">
        当前客户端暂不提供内置浏览器。已发送的网页批注仍可在聊天中查看。
      </p>
    )
  if (!snapshot)
    return (
      <p role="status" className="p-6 text-sm">
        {error || '正在读取浏览器设置…'}
      </p>
    )
  const settings = snapshot.settings
  const save = (patch: Partial<Preferences>) => void run(() => platform.settings(patch))
  const row = (title: string, description: string, control: React.ReactNode) => (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 py-4 last:border-0">
      <div className="min-w-0">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
  const select = <K extends keyof Preferences>(key: K, choices: Array<[Preferences[K], string]>) => (
    <select
      aria-label={
        (
          {
            links: '网页链接打开位置',
            localLinks: '本地网址打开位置',
            search: '搜索引擎',
            screenshots: '批注截图',
          } as Record<string, string>
        )[key] ?? key
      }
      disabled={saving}
      value={String(settings[key])}
      onChange={(event) => save({ [key]: event.target.value })}
      className="max-w-48 rounded-lg border border-border bg-secondary px-3 py-2 text-xs"
    >
      {choices.map(([value, label]) => (
        <option key={String(value)} value={String(value)}>
          {label}
        </option>
      ))}
    </select>
  )
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-6 text-foreground">
      <nav className="flex flex-wrap gap-2" aria-label="浏览器设置分类">
        {(
          [
            ['general', '常规'],
            ['history', '历史记录'],
            ['downloads', '下载'],
            ['permissions', '网站权限'],
          ] as const
        ).map(([id, label]) => (
          <Button key={id} size="sm" variant={section === id ? 'secondary' : 'ghost'} onClick={() => setSection(id)}>
            {label}
          </Button>
        ))}
      </nav>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {section === 'general' ? (
        <div className="rounded-xl border border-border bg-card px-4">
          {row(
            '网页链接打开位置',
            '聊天中的普通网页链接。',
            select('links', [
              ['external', '系统浏览器'],
              ['internal', '内置浏览器'],
            ]),
          )}
          {row(
            '本地网址打开位置',
            'localhost 和回环 IP 指向当前电脑。',
            select('localLinks', [
              ['internal', '内置浏览器'],
              ['external', '系统浏览器'],
            ]),
          )}
          {row(
            '搜索引擎',
            '地址栏中的搜索文字使用此引擎。',
            select('search', [
              ['bing', 'Bing'],
              ['google', 'Google'],
              ['duckduckgo', 'DuckDuckGo'],
            ]),
          )}
          {row(
            '显示完整网址',
            '编辑地址时始终显示完整网址。',
            <Switch
              checked={settings.fullUrl}
              disabled={saving}
              onChange={(fullUrl) => save({ fullUrl })}
              label="显示完整网址"
            />,
          )}
          {row(
            '批注截图',
            '每条批注可以单独调整截图方式。',
            select('screenshots', [
              ['element', '元素截图'],
              ['viewport', '当前视口'],
              ['none', '不附截图'],
            ]),
          )}
          {row(
            '恢复网页和批注',
            '重新启动后，选中网页时重新加载。',
            <Switch
              checked={settings.restore}
              disabled={saving}
              onChange={(restore) => save({ restore })}
              label="恢复网页和批注"
            />,
          )}
          {row(
            '浏览数据',
            '分别清理历史、网站数据、缓存和下载记录。',
            <Button variant="outline" disabled={saving} onClick={() => setClearing(true)}>
              清理浏览数据
            </Button>,
          )}
        </div>
      ) : null}
      {section === 'history' ? (
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              aria-label="搜索浏览历史"
              placeholder="搜索浏览历史"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => {
                setParts(['history'])
                setClearing(true)
              }}
            >
              清空
            </Button>
          </div>
          {snapshot.history
            .filter((item) => `${item.title} ${item.url}`.toLowerCase().includes(query.toLowerCase()))
            .map((item) => (
              <div key={item.id} className="flex items-center gap-3 rounded-xl border border-border p-3">
                <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(item.url)}>
                  <p className="truncate text-sm">{item.title}</p>
                  <p className="truncate text-xs text-muted-foreground">{item.url}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{new Date(item.visitedAt).toLocaleString()}</p>
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => void run(() => platform.history(item.id))}
                >
                  删除
                </Button>
              </div>
            ))}
          {!snapshot.history.length ? <p className="text-sm text-muted-foreground">暂无浏览记录。</p> : null}
        </div>
      ) : null}
      {section === 'downloads' ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-border px-4">
            {row(
              '下载位置',
              settings.downloadDirectory || '系统下载目录',
              <Button
                variant="outline"
                disabled={saving}
                onClick={() =>
                  void run(async () => {
                    const directory = await platform.chooseDownloadDirectory()
                    if (directory) await platform.settings({ downloadDirectory: directory })
                  })
                }
              >
                更改
              </Button>,
            )}
            {row(
              '下载前询问保存位置',
              '每次下载显示系统保存对话框。',
              <Switch
                checked={settings.askDownload}
                disabled={saving}
                onChange={(askDownload) => save({ askDownload })}
                label="下载前询问保存位置"
              />,
            )}
          </div>
          {snapshot.downloads.map((item) => (
            <div key={item.id} className="rounded-xl border border-border p-3">
              <p className="truncate text-sm">{item.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {{ progressing: '下载中', completed: '已完成', cancelled: '已取消', interrupted: '已中断' }[item.state]}{' '}
                · {(item.received / 1024 / 1024).toFixed(1)} / {(item.total / 1024 / 1024).toFixed(1)} MB
              </p>
              <div className="mt-2 flex gap-2">
                {item.state === 'progressing' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void run(() => platform.download(item.id, 'cancel'))}
                  >
                    取消
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={item.state !== 'completed'}
                      onClick={() => void run(() => platform.download(item.id, 'open'))}
                    >
                      打开
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={item.state !== 'completed'}
                      onClick={() => void run(() => platform.download(item.id, 'reveal'))}
                    >
                      在 Finder 显示
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void run(() => platform.download(item.id, 'remove'))}
                    >
                      删除记录
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
          {!snapshot.downloads.length ? <p className="text-sm text-muted-foreground">暂无下载记录。</p> : null}
        </div>
      ) : null}
      {section === 'permissions' ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">未单独设置的网站默认询问。系统权限仍由 macOS 控制。</p>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                await platform.permission({ origin: new URL(origin).origin, permission, value: grant })
                setOrigin('')
              })
            }}
          >
            <Input
              className="min-w-48 flex-1"
              aria-label="网站地址"
              placeholder="https://example.com"
              required
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
            />
            <select
              aria-label="权限类型"
              className="rounded bg-secondary px-2 text-xs"
              value={permission}
              onChange={(event) => setPermission(event.target.value)}
            >
              {Object.entries(permissionNames).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <select
              aria-label="网站权限"
              className="rounded bg-secondary px-2 text-xs"
              value={grant}
              onChange={(event) => setGrant(event.target.value as BrowserPermission['value'])}
            >
              <option value="ask">询问</option>
              <option value="allow">允许</option>
              <option value="deny">禁止</option>
            </select>
            <Button type="submit" disabled={saving}>
              添加
            </Button>
          </form>
          {snapshot.permissions.map((item) => (
            <div
              key={`${item.origin}:${item.permission}`}
              className="flex items-center justify-between gap-3 rounded-xl border border-border p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">{item.origin}</p>
                <p className="text-xs text-muted-foreground">
                  {permissionNames[item.permission] || item.permission} · {item.value === 'allow' ? '允许' : '禁止'}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void run(() => platform.permission({ ...item, value: 'ask' }))}
              >
                恢复询问
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <Dialog open={clearing} onOpenChange={setClearing}>
        <DialogContent>
          <DialogTitle>清理浏览数据</DialogTitle>
          <DialogDescription>清理网站数据会退出网站登录。下载文件、聊天批注和应用登录信息会保留。</DialogDescription>
          <div className="space-y-3">
            {(
              [
                ['history', '浏览历史'],
                ['storage', 'Cookie 和网站存储'],
                ['cache', '缓存'],
                ['downloads', '下载记录'],
              ] as const
            ).map(([id, label]) => (
              <label key={id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={parts.includes(id)}
                  onChange={(event) =>
                    setParts((value) => (event.target.checked ? [...value, id] : value.filter((part) => part !== id)))
                  }
                />
                {label}
              </label>
            ))}
          </div>
          <Button
            disabled={saving || !parts.length}
            onClick={() =>
              void run(async () => {
                await platform.clear(parts)
                setClearing(false)
              })
            }
          >
            清理所选数据
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
