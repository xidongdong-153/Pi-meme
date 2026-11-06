import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
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
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { RevealContent } from '@pi-meme/ui/components/reveal-content'
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  settingsCardClassName,
  settingsControlClassName,
} from '@pi-meme/ui/components/settings'
import { cn } from '@pi-meme/ui/lib/utils'

const permissionNames: Record<string, string> = {
  media: '摄像头与麦克风',
  geolocation: '位置',
  'clipboard-read': '读取剪贴板',
  notifications: '通知',
  fullscreen: '全屏',
}
const permissionValues: Record<BrowserPermission['value'], string> = { ask: '询问', allow: '允许', deny: '禁止' }

export function BrowserSettings({
  platform,
  onOpen,
  initialSection = 'general',
  openClear = false,
}: {
  platform?: BrowserPlatform
  onOpen: (url: string) => void
  initialSection?: 'general' | 'history' | 'downloads'
  openClear?: boolean
}) {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>()
  const [section, setSection] = useState<'general' | 'history' | 'downloads' | 'permissions'>(initialSection)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(openClear)
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
      <SettingsCard className="px-4 py-3 leading-relaxed text-muted-foreground">
        当前客户端暂不提供内置浏览器。已发送的网页批注仍可在聊天中查看。
      </SettingsCard>
    )
  const settings = snapshot?.settings
  const history =
    snapshot?.history.filter((item) =>
      `${item.title} ${item.url}`.toLowerCase().includes(query.trim().toLowerCase()),
    ) ?? []
  const save = (patch: Partial<Preferences>) => void run(() => platform.settings(patch))
  const row = (title: string, description: string, control: React.ReactNode) => (
    <SettingsRow>
      <div className="min-w-0 flex-1 basis-52 space-y-0.5">
        <p className="font-medium">{title}</p>
        <p className="break-words text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          <CrossfadeText>{description}</CrossfadeText>
        </p>
      </div>
      <div className="max-w-full shrink-0">{control}</div>
    </SettingsRow>
  )
  const select = <K extends keyof Preferences>(key: K, choices: Array<[Preferences[K], string]>) => (
    <Select
      disabled={saving || !settings}
      value={settings ? String(settings[key]) : undefined}
      onValueChange={(value) => save({ [key]: value })}
    >
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
        className={cn(settingsControlClassName, 'w-44 bg-secondary/60')}
      >
        <SelectValue placeholder="读取中…">
          <CrossfadeText>
            {settings ? (choices.find(([value]) => value === settings[key])?.[1] ?? String(settings[key])) : '读取中…'}
          </CrossfadeText>
        </SelectValue>
      </SelectTrigger>
      <SelectContent side="bottom" align="end">
        {choices.map(([value, label]) => (
          <SelectItem key={String(value)} value={String(value)} className="text-xs">
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
              settingsControlClassName,
              'px-3 font-normal',
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
          className="break-words rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
      {section === 'general' ? (
        <div className="space-y-6">
          <SettingsGroup title="网页与搜索">
            <SettingsCard>
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
                <div
                  aria-hidden={!snapshot}
                  inert={!snapshot}
                  className={cn(
                    'h-6 w-11 transition-opacity duration-150 motion-reduce:transition-none',
                    snapshot ? 'opacity-100' : 'pointer-events-none opacity-0',
                  )}
                >
                  {settings && (
                    <Switch
                      checked={settings.fullUrl}
                      disabled={saving || !snapshot}
                      onChange={(fullUrl) => save({ fullUrl })}
                      label="显示完整网址"
                    />
                  )}
                </div>,
              )}
            </SettingsCard>
          </SettingsGroup>
          <SettingsGroup title="网页批注与恢复">
            <SettingsCard>
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
                <div
                  aria-hidden={!snapshot}
                  inert={!snapshot}
                  className={cn(
                    'h-6 w-11 transition-opacity duration-150 motion-reduce:transition-none',
                    snapshot ? 'opacity-100' : 'pointer-events-none opacity-0',
                  )}
                >
                  {settings && (
                    <Switch
                      checked={settings.restore}
                      disabled={saving || !snapshot}
                      onChange={(restore) => save({ restore })}
                      label="恢复网页和批注"
                    />
                  )}
                </div>,
              )}
            </SettingsCard>
          </SettingsGroup>
          <SettingsGroup title="浏览数据">
            <SettingsCard>
              {row(
                '浏览数据',
                '分别清理历史、网站数据、缓存和下载记录。',
                <Button
                  className={settingsControlClassName}
                  variant="outline"
                  size="sm"
                  disabled={saving || !snapshot}
                  onClick={() => setClearing(true)}
                >
                  <Trash2 aria-hidden="true" />
                  清理浏览数据
                </Button>,
              )}
            </SettingsCard>
          </SettingsGroup>
        </div>
      ) : null}
      {section === 'history' ? (
        <div className="space-y-6">
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
                className="h-9 rounded-lg border-border/80 bg-secondary/50 pl-9 text-xs shadow-none focus-visible:bg-secondary/80"
              />
            </div>
            <Button
              className={settingsControlClassName}
              variant="outline"
              size="sm"
              disabled={saving || !snapshot?.history.length}
              onClick={() => {
                setParts(['history'])
                setClearing(true)
              }}
            >
              <Trash2 aria-hidden="true" />
              清空历史
            </Button>
          </div>
          <RevealContent ready={Boolean(snapshot)}>
            {history.length ? (
              <SettingsCard>
                {history.map((item) => (
                  <SettingsRow key={item.id} className="flex-nowrap">
                    <Globe aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    <button
                      className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onOpen(item.url)}
                    >
                      <p className="truncate font-medium">{item.title || item.url}</p>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{item.url}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {new Date(item.visitedAt).toLocaleString()}
                      </p>
                    </button>
                    <Button
                      className={settingsControlClassName}
                      size="sm"
                      variant="ghost"
                      disabled={saving || !snapshot}
                      onClick={() => void run(() => platform.history(item.id))}
                    >
                      删除
                    </Button>
                  </SettingsRow>
                ))}
              </SettingsCard>
            ) : (
              <SettingsCard role="status" className="divide-y-0 px-4 py-8 text-center">
                <History aria-hidden="true" className="mx-auto mb-2 size-5 text-muted-foreground" />
                <p className="font-medium">{snapshot?.history.length ? '没有匹配的浏览记录' : '暂无浏览记录'}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {snapshot?.history.length ? '试试其他标题或网址。' : '访问过的网页会显示在这里。'}
                </p>
              </SettingsCard>
            )}
          </RevealContent>
        </div>
      ) : null}
      {section === 'downloads' ? (
        <div className="space-y-6">
          <SettingsGroup title="下载设置">
            <SettingsCard>
              {row(
                '下载位置',
                settings ? settings.downloadDirectory || '系统下载目录' : '读取中…',
                <Button
                  className={settingsControlClassName}
                  variant="outline"
                  size="sm"
                  disabled={saving || !snapshot}
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
                <div
                  aria-hidden={!snapshot}
                  inert={!snapshot}
                  className={cn(
                    'h-6 w-11 transition-opacity duration-150 motion-reduce:transition-none',
                    snapshot ? 'opacity-100' : 'pointer-events-none opacity-0',
                  )}
                >
                  {settings && (
                    <Switch
                      checked={settings.askDownload}
                      disabled={saving || !snapshot}
                      onChange={(askDownload) => save({ askDownload })}
                      label="下载前询问保存位置"
                    />
                  )}
                </div>,
              )}
            </SettingsCard>
          </SettingsGroup>
          <SettingsGroup title="下载记录">
            <RevealContent ready={Boolean(snapshot)}>
              {snapshot?.downloads.length ? (
                <SettingsCard>
                  {snapshot?.downloads.map((item) => (
                    <SettingsRow key={item.id} className="flex-nowrap items-start">
                      <File aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <TooltipHint content={item.name}>
                          <p className="truncate font-medium">{item.name}</p>
                        </TooltipHint>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          <CrossfadeText>{`${{ progressing: '下载中', completed: '已完成', cancelled: '已取消', interrupted: '已中断' }[item.state]} · ${(item.received / 1024 / 1024).toFixed(1)} / ${(item.total / 1024 / 1024).toFixed(1)} MB`}</CrossfadeText>
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
                              className={settingsControlClassName}
                              size="sm"
                              variant="outline"
                              onClick={() => void run(() => platform.download(item.id, 'cancel'))}
                            >
                              取消
                            </Button>
                          ) : (
                            <>
                              <Button
                                className={settingsControlClassName}
                                size="sm"
                                variant="ghost"
                                disabled={item.state !== 'completed'}
                                onClick={() => void run(() => platform.download(item.id, 'open'))}
                              >
                                打开
                              </Button>
                              <Button
                                className={settingsControlClassName}
                                size="sm"
                                variant="ghost"
                                disabled={item.state !== 'completed'}
                                onClick={() => void run(() => platform.download(item.id, 'reveal'))}
                              >
                                在 Finder 显示
                              </Button>
                              <Button
                                className={settingsControlClassName}
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
                    </SettingsRow>
                  ))}
                </SettingsCard>
              ) : (
                <SettingsCard role="status" className="divide-y-0 px-4 py-8 text-center">
                  <Download aria-hidden="true" className="mx-auto mb-2 size-5 text-muted-foreground" />
                  <p className="font-medium">暂无下载记录</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">下载的文件和进度会显示在这里。</p>
                </SettingsCard>
              )}
            </RevealContent>
          </SettingsGroup>
        </div>
      ) : null}
      {section === 'permissions' ? (
        <div className="space-y-6">
          <SettingsGroup title="添加网站权限">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              未单独设置的网站默认询问。系统权限仍由 macOS 控制。
            </p>
            <form
              className={cn(settingsCardClassName, 'space-y-3 divide-y-0 px-4 py-3')}
              onSubmit={(event) => {
                event.preventDefault()
                void run(async () => {
                  await platform.permission({ origin: new URL(origin).origin, permission, value: grant })
                  setOrigin('')
                })
              }}
            >
              <label className="block space-y-1.5">
                <span className="font-medium">网站地址</span>
                <Input
                  aria-label="网站地址"
                  className={settingsControlClassName}
                  placeholder="https://example.com"
                  required
                  value={origin}
                  onChange={(event) => setOrigin(event.target.value)}
                />
              </label>
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-0 flex-1 basis-48 space-y-1.5">
                  <p className="font-medium">权限类型</p>
                  <Select value={permission} onValueChange={setPermission}>
                    <SelectTrigger aria-label="权限类型" className={settingsControlClassName}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent side="bottom">
                      {Object.entries(permissionNames).map(([id, name]) => (
                        <SelectItem key={id} value={id} className="text-xs">
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0 flex-1 basis-28 space-y-1.5">
                  <p className="font-medium">网站权限</p>
                  <Select value={grant} onValueChange={(value) => setGrant(value as BrowserPermission['value'])}>
                    <SelectTrigger aria-label="网站权限" className={settingsControlClassName}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent side="bottom">
                      {Object.entries(permissionValues).map(([value, label]) => (
                        <SelectItem key={value} value={value} className="text-xs">
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button className={settingsControlClassName} type="submit" disabled={saving || !snapshot}>
                  添加
                </Button>
              </div>
            </form>
          </SettingsGroup>
          <SettingsGroup title="已设置的网站">
            <RevealContent ready={Boolean(snapshot)}>
              {snapshot?.permissions.length ? (
                <SettingsCard>
                  {snapshot?.permissions.map((item) => (
                    <SettingsRow key={`${item.origin}:${item.permission}`}>
                      <div className="min-w-0 flex-1 basis-48 space-y-0.5">
                        <p className="break-all font-medium">{item.origin}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {permissionNames[item.permission] || item.permission} · {permissionValues[item.value]}
                        </p>
                      </div>
                      <Button
                        className={settingsControlClassName}
                        variant="ghost"
                        size="sm"
                        onClick={() => void run(() => platform.permission({ ...item, value: 'ask' }))}
                      >
                        恢复询问
                      </Button>
                    </SettingsRow>
                  ))}
                </SettingsCard>
              ) : (
                <SettingsCard role="status" className="divide-y-0 px-4 py-8 text-center">
                  <ShieldCheck aria-hidden="true" className="mx-auto mb-2 size-5 text-muted-foreground" />
                  <p className="font-medium">暂无网站权限设置</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">网站请求权限时会先询问。</p>
                </SettingsCard>
              )}
            </RevealContent>
          </SettingsGroup>
        </div>
      ) : null}
      <Dialog open={clearing} onOpenChange={setClearing}>
        <DialogContent className="gap-4">
          <DialogHeader>
            <DialogTitle className="text-sm">清理浏览数据</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              清理网站数据会退出网站登录。下载文件、聊天批注和应用登录信息会保留。
            </DialogDescription>
          </DialogHeader>
          <SettingsCard>
            {(
              [
                ['history', '浏览历史'],
                ['storage', 'Cookie 和网站存储'],
                ['cache', '缓存'],
                ['downloads', '下载记录'],
              ] as const
            ).map(([id, label]) => (
              <SettingsRow key={id} className="flex-nowrap">
                <span>{label}</span>
                <Switch
                  label={label}
                  checked={parts.includes(id)}
                  disabled={saving || !snapshot}
                  onChange={(checked) =>
                    setParts((value) => (checked ? [...value, id] : value.filter((part) => part !== id)))
                  }
                />
              </SettingsRow>
            ))}
          </SettingsCard>
          <DialogFooter>
            <Button
              className={settingsControlClassName}
              variant="outline"
              disabled={saving || !snapshot}
              onClick={() => setClearing(false)}
            >
              取消
            </Button>
            <Button
              className={settingsControlClassName}
              variant="destructive"
              disabled={saving || !parts.length}
              onClick={() =>
                void run(async () => {
                  await platform.clear(parts)
                  setClearing(false)
                })
              }
            >
              <CrossfadeText reserve={['正在清理…', '清理所选数据']}>
                {saving ? '正在清理…' : '清理所选数据'}
              </CrossfadeText>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
