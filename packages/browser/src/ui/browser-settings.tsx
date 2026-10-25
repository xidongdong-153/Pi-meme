import { useEffect, useState } from 'react'
import { Download, File, Globe, History, Search, ShieldCheck, Trash2 } from 'lucide-react'
import type {
  BrowserPermission,
  BrowserPlatform,
  BrowserSettings as Preferences,
  BrowserSnapshot,
} from '@pi-meme/contracts/browser'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@pi-meme/ui/components/ui/dialog'
import { cn } from '@pi-meme/ui/lib/utils'

const permissionNames: Record<string, string> = {
  media: '摄像头与麦克风',
  geolocation: '位置',
  'clipboard-read': '读取剪贴板',
  notifications: '通知',
  fullscreen: '全屏',
}
const permissionValues: Record<BrowserPermission['value'], string> = { ask: '询问', allow: '允许', deny: '禁止' }

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
      <p className="rounded-2xl border border-border bg-card p-5 text-sm leading-relaxed text-muted-foreground">
        当前客户端暂不提供内置浏览器。已发送的网页批注仍可在聊天中查看。
      </p>
    )
  if (!snapshot)
    return (
      <p role="status" className="rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground">
        {error || '正在读取浏览器设置…'}
      </p>
    )
  const settings = snapshot.settings
  const history = snapshot.history.filter((item) =>
    `${item.title} ${item.url}`.toLowerCase().includes(query.trim().toLowerCase()),
  )
  const save = (patch: Partial<Preferences>) => void run(() => platform.settings(patch))
  const row = (title: string, description: string, control: React.ReactNode) => (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4">
      <div className="min-w-0 flex-1 basis-52 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="break-words text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {description}
        </p>
      </div>
      <div className="max-w-full shrink-0">{control}</div>
    </div>
  )
  const select = <K extends keyof Preferences>(key: K, choices: Array<[Preferences[K], string]>) => (
    <Select disabled={saving} value={String(settings[key])} onValueChange={(value) => save({ [key]: value })}>
      <SelectTrigger
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
        className="h-8 w-44 max-w-full rounded-full bg-background"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent side="bottom" align="end">
        {choices.map(([value, label]) => (
          <SelectItem key={String(value)} value={String(value)}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-1" aria-label="浏览器设置分类">
        {(
          [
            ['general', '常规'],
            ['history', '历史记录'],
            ['downloads', '下载'],
            ['permissions', '网站权限'],
          ] as const
        ).map(([id, label]) => (
          <Button
            key={id}
            variant="ghost"
            aria-current={section === id ? 'page' : undefined}
            className={cn(
              'h-auto rounded-xl px-3 py-2 font-normal',
              section === id ? 'bg-secondary font-medium' : 'text-muted-foreground',
            )}
            onClick={() => setSection(id)}
          >
            {label}
          </Button>
        ))}
      </nav>
      {error ? (
        <p
          role="alert"
          className="break-words rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {section === 'general' ? (
        <div className="space-y-6">
          <section className="space-y-3" aria-label="网页与搜索">
            <h3 className="text-sm font-medium">网页与搜索</h3>
            <div className="divide-y divide-border rounded-2xl border border-border bg-card px-5">
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
                '关闭时隐藏网址路径，编辑地址时仍显示完整网址。',
                <Switch
                  checked={settings.fullUrl}
                  disabled={saving}
                  onChange={(fullUrl) => save({ fullUrl })}
                  label="显示完整网址"
                />,
              )}
            </div>
          </section>
          <section className="space-y-3" aria-label="网页批注与恢复">
            <h3 className="text-sm font-medium">网页批注与恢复</h3>
            <div className="divide-y divide-border rounded-2xl border border-border bg-card px-5">
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
            </div>
          </section>
          <section className="space-y-3" aria-label="浏览数据">
            <h3 className="text-sm font-medium">浏览数据</h3>
            <div className="rounded-2xl border border-border bg-card px-5">
              {row(
                '浏览数据',
                '分别清理历史、网站数据、缓存和下载记录。',
                <Button variant="outline" size="sm" disabled={saving} onClick={() => setClearing(true)}>
                  <Trash2 aria-hidden="true" />
                  清理浏览数据
                </Button>,
              )}
            </div>
          </section>
        </div>
      ) : null}
      {section === 'history' ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-0 flex-1 basis-48">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
              />
              <Input
                aria-label="搜索浏览历史"
                placeholder="搜索浏览历史"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="rounded-full pl-9"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={saving || !snapshot.history.length}
              onClick={() => {
                setParts(['history'])
                setClearing(true)
              }}
            >
              <Trash2 aria-hidden="true" />
              清空历史
            </Button>
          </div>
          {history.length ? (
            <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
              {history.map((item) => (
                <div key={item.id} className="flex items-center gap-3 px-5 py-4">
                  <Globe aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <button
                    className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onOpen(item.url)}
                  >
                    <p className="truncate text-sm font-medium">{item.title || item.url}</p>
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
            </div>
          ) : (
            <div role="status" className="rounded-2xl border border-border bg-card px-5 py-10 text-center">
              <History aria-hidden="true" className="mx-auto mb-3 size-6 text-muted-foreground" />
              <p className="text-sm font-medium">{snapshot.history.length ? '没有匹配的浏览记录' : '暂无浏览记录'}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {snapshot.history.length ? '试试其他标题或网址。' : '访问过的网页会显示在这里。'}
              </p>
            </div>
          )}
        </div>
      ) : null}
      {section === 'downloads' ? (
        <div className="space-y-6">
          <section className="space-y-3" aria-label="下载设置">
            <h3 className="text-sm font-medium">下载设置</h3>
            <div className="divide-y divide-border rounded-2xl border border-border bg-card px-5">
              {row(
                '下载位置',
                settings.downloadDirectory || '系统下载目录',
                <Button
                  variant="outline"
                  size="sm"
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
          </section>
          <section className="space-y-3" aria-label="下载记录">
            <h3 className="text-sm font-medium">下载记录</h3>
            {snapshot.downloads.length ? (
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
                {snapshot.downloads.map((item) => (
                  <div key={item.id} className="flex gap-3 px-5 py-4">
                    <File aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" title={item.name}>
                        {item.name}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {
                          { progressing: '下载中', completed: '已完成', cancelled: '已取消', interrupted: '已中断' }[
                            item.state
                          ]
                        }{' '}
                        · {(item.received / 1024 / 1024).toFixed(1)} / {(item.total / 1024 / 1024).toFixed(1)} MB
                      </p>
                      {item.state === 'progressing' && item.total > 0 ? (
                        <div
                          role="progressbar"
                          aria-label={`${item.name} 下载进度`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.min(100, Math.round((item.received / item.total) * 100))}
                          className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary"
                        >
                          <div
                            className="h-full rounded-full bg-primary transition-[width]"
                            style={{ width: `${Math.min(100, (item.received / item.total) * 100)}%` }}
                          />
                        </div>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-2">
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
                  </div>
                ))}
              </div>
            ) : (
              <div role="status" className="rounded-2xl border border-border bg-card px-5 py-10 text-center">
                <Download aria-hidden="true" className="mx-auto mb-3 size-6 text-muted-foreground" />
                <p className="text-sm font-medium">暂无下载记录</p>
                <p className="mt-1 text-sm text-muted-foreground">下载的文件和进度会显示在这里。</p>
              </div>
            )}
          </section>
        </div>
      ) : null}
      {section === 'permissions' ? (
        <div className="space-y-6">
          <section className="space-y-3" aria-label="添加网站权限">
            <div className="space-y-1">
              <h3 className="text-sm font-medium">添加网站权限</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                未单独设置的网站默认询问。系统权限仍由 macOS 控制。
              </p>
            </div>
            <form
              className="space-y-4 rounded-2xl border border-border bg-card p-5"
              onSubmit={(event) => {
                event.preventDefault()
                void run(async () => {
                  await platform.permission({ origin: new URL(origin).origin, permission, value: grant })
                  setOrigin('')
                })
              }}
            >
              <label className="block space-y-2">
                <span className="text-sm font-medium">网站地址</span>
                <Input
                  aria-label="网站地址"
                  placeholder="https://example.com"
                  required
                  value={origin}
                  onChange={(event) => setOrigin(event.target.value)}
                />
              </label>
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-0 flex-1 basis-48 space-y-2">
                  <p className="text-sm font-medium">权限类型</p>
                  <Select value={permission} onValueChange={setPermission}>
                    <SelectTrigger aria-label="权限类型">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent side="bottom">
                      {Object.entries(permissionNames).map(([id, name]) => (
                        <SelectItem key={id} value={id}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0 flex-1 basis-28 space-y-2">
                  <p className="text-sm font-medium">网站权限</p>
                  <Select value={grant} onValueChange={(value) => setGrant(value as BrowserPermission['value'])}>
                    <SelectTrigger aria-label="网站权限">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent side="bottom">
                      {Object.entries(permissionValues).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="submit" disabled={saving}>
                  添加
                </Button>
              </div>
            </form>
          </section>
          <section className="space-y-3" aria-label="已设置的网站">
            <h3 className="text-sm font-medium">已设置的网站</h3>
            {snapshot.permissions.length ? (
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
                {snapshot.permissions.map((item) => (
                  <div
                    key={`${item.origin}:${item.permission}`}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
                  >
                    <div className="min-w-0 flex-1 basis-48 space-y-1">
                      <p className="break-all text-sm font-medium">{item.origin}</p>
                      <p className="text-sm text-muted-foreground">
                        {permissionNames[item.permission] || item.permission} · {permissionValues[item.value]}
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
            ) : (
              <div role="status" className="rounded-2xl border border-border bg-card px-5 py-10 text-center">
                <ShieldCheck aria-hidden="true" className="mx-auto mb-3 size-6 text-muted-foreground" />
                <p className="text-sm font-medium">暂无网站权限设置</p>
                <p className="mt-1 text-sm text-muted-foreground">网站请求权限时会先询问。</p>
              </div>
            )}
          </section>
        </div>
      ) : null}
      <Dialog open={clearing} onOpenChange={setClearing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清理浏览数据</DialogTitle>
            <DialogDescription>清理网站数据会退出网站登录。下载文件、聊天批注和应用登录信息会保留。</DialogDescription>
          </DialogHeader>
          <div className="divide-y divide-border rounded-xl border border-border px-4">
            {(
              [
                ['history', '浏览历史'],
                ['storage', 'Cookie 和网站存储'],
                ['cache', '缓存'],
                ['downloads', '下载记录'],
              ] as const
            ).map(([id, label]) => (
              <div key={id} className="flex items-center justify-between gap-4 py-3 text-sm">
                <span>{label}</span>
                <Switch
                  label={label}
                  checked={parts.includes(id)}
                  disabled={saving}
                  onChange={(checked) =>
                    setParts((value) => (checked ? [...value, id] : value.filter((part) => part !== id)))
                  }
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setClearing(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={saving || !parts.length}
              onClick={() =>
                void run(async () => {
                  await platform.clear(parts)
                  setClearing(false)
                })
              }
            >
              {saving ? '正在清理…' : '清理所选数据'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
