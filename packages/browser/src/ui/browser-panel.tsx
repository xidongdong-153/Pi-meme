import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  Globe,
  MessageCircle,
  MoreHorizontal,
  MousePointer2,
  Pencil,
  RefreshCw,
  Search,
  Settings,
  Square,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import type {
  BrowserAnnotation,
  BrowserCommand,
  BrowserPlatform,
  BrowserTab,
  BrowserHistory,
} from '@pi-meme/contracts/browser'
import type { ThemeColors } from '@pi-meme/contracts/settings'

const overlayColorKeys = [
  'background',
  'surface',
  'elevated',
  'text',
  'muted',
  'border',
  'accent',
  'accentText',
  'success',
  'error',
] as const

export function BrowserFavicon({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false)
  return src && !failed ? (
    <img src={src} alt="" className="size-4 rounded-sm object-contain" onError={() => setFailed(true)} />
  ) : (
    <Globe className="size-4" />
  )
}

export function BrowserPanel({
  platform,
  tab,
  annotations,
  editor,
  onSettings,
  onFocusChat,
  saveError,
  onRetrySave,
}: {
  platform: BrowserPlatform
  tab: BrowserTab
  annotations: BrowserAnnotation[]
  editor?: BrowserAnnotation
  onSettings: (section?: 'general' | 'history' | 'downloads' | 'clear') => void
  onFocusChat: () => void
  saveError?: string
  onRetrySave?: () => void
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const currentTab = useRef(tab)
  currentTab.current = tab
  const currentAnnotations = useRef(annotations)
  currentAnnotations.current = annotations
  const [recent, setRecent] = useState<BrowserHistory[]>([])
  const [fullUrl, setFullUrl] = useState(false)
  const [focused, setFocused] = useState(false)
  const [address, setAddress] = useState(tab.url === 'about:blank' ? '' : tab.url)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [finding, setFinding] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const zoom = tab.zoom ?? 1
  const [annotating, setAnnotating] = useState(false)
  useEffect(() => {
    void platform
      .snapshot()
      .then((snapshot) => {
        setFullUrl(snapshot.settings.fullUrl)
        setRecent(snapshot.history.slice(0, 6))
      })
      .catch(() => {})
  }, [platform])
  useEffect(() => setAddress(tab.url === 'about:blank' ? '' : tab.url), [tab.url])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 380))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const release = platform.onEvent((event) => {
      if (event.type === 'annotation-mode' && event.tabId === tab.id) setAnnotating(event.enabled)
    })
    return release
  }, [platform, tab.id])
  const command = async (value: BrowserCommand) => {
    try {
      setError('')
      await platform.command(tab.id, value)
    } catch (cause) {
      setError(String(cause))
    }
  }
  const menuCommand = (value: BrowserCommand) => {
    window.setTimeout(() => void command(value), 200)
  }
  useEffect(() => {
    let cancelled = false
    let frame = 0
    let last = ''
    const measure = () => {
      frame = requestAnimationFrame(measure)
      const element = viewport.current
      if (!element || cancelled) return
      const box = element.getBoundingClientRect()
      const blocked = !!document.querySelector(
        '[role="dialog"][data-state="open"], [role="alertdialog"], [data-radix-popper-content-wrapper]',
      )
      const visible = box.width > 0 && box.height > 0 && !element.closest('[inert]') && !document.hidden && !blocked
      const bounds = visible ? { x: box.x, y: box.y, width: box.width, height: box.height } : null
      const root = document.documentElement
      const theme = root.dataset.appearance === 'light' ? 'light' : 'dark'
      let computed: CSSStyleDeclaration | undefined
      const colors = Object.fromEntries(
        overlayColorKeys.map((key) => [
          key,
          root.style.getPropertyValue(`--color-${key}`) ||
            (computed ??= getComputedStyle(root)).getPropertyValue(`--color-${key}`),
        ]),
      ) as ThemeColors
      const next = JSON.stringify([bounds, theme, colors, currentTab.current.error, currentTab.current.url])
      if (last !== next) {
        last = next
        void platform
          .present(tab.id, bounds, theme, colors)
          .then((image) => {
            if (!cancelled && image) setPreview(image)
          })
          .catch((cause) => {
            if (!cancelled) setError(String(cause))
          })
      }
    }
    void platform
      .create(tab.owner, tab.id, tab.url)
      .then(() => {
        if (cancelled) return
        frame = requestAnimationFrame(measure)
        void platform.command(tab.id, { type: 'annotation-state' }).catch(() => {})
        void platform.command(tab.id, { type: 'markers', annotations: currentAnnotations.current }).catch(() => {})
        if (editor) void platform.command(tab.id, { type: 'annotate', enabled: true })
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause))
      })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      void platform.present(tab.id, null).catch(() => {})
    }
  }, [platform, tab.id, tab.owner])
  useEffect(() => {
    void platform.command(tab.id, { type: 'markers', annotations }).catch(() => {})
  }, [platform, tab.id, annotations])
  const changeZoom = (value: number) => void command({ type: 'zoom', value: Math.max(0.25, Math.min(3, value)) })
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border bg-background px-2 no-drag">
        <div className="flex h-8 shrink-0 items-center rounded-full bg-secondary/80 px-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            title="后退"
            aria-label="后退"
            disabled={!tab.canGoBack}
            onClick={() => void command({ type: 'back' })}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="前进"
            aria-label="前进"
            className={narrow ? 'hidden' : undefined}
            disabled={!tab.canGoForward}
            onClick={() => void command({ type: 'forward' })}
          >
            <ArrowRight className="size-4" />
          </Button>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <Button
            size="icon-sm"
            variant="ghost"
            title={tab.loading ? '停止加载' : '刷新'}
            aria-label={tab.loading ? '停止加载' : '刷新'}
            onClick={() => void command({ type: tab.loading ? 'stop' : 'reload' })}
          >
            {tab.loading ? <Square className="size-3.5" /> : <RefreshCw className="size-3.5" />}
          </Button>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className={`h-8 shrink-0 rounded-full ${narrow ? 'px-2' : 'px-3'} ${annotating ? 'bg-primary/15 text-primary' : 'bg-secondary/80'}`}
          aria-label="选择元素批注"
          aria-pressed={annotating}
          disabled={tab.url === 'about:blank' || !!tab.error}
          onClick={() => void command({ type: 'annotate', enabled: !annotating })}
        >
          <MousePointer2 className="size-4" />
          {narrow ? null : '批注'}
        </Button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            if (!finding) void command({ type: 'navigate', url: address })
          }}
        >
          {finding ? (
            <input
              autoFocus
              aria-label="在页面中查找"
              placeholder="在页面中查找 · Esc 关闭"
              className="h-8 w-full rounded-full bg-secondary/80 px-3 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onChange={(event) => void command({ type: 'find', text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setFinding(false)
                  void command({ type: 'find', text: '' })
                }
              }}
            />
          ) : (
            <input
              aria-label="搜索或输入网址"
              placeholder="搜索或输入网址"
              value={
                focused || fullUrl || tab.url === 'about:blank'
                  ? address
                  : (() => {
                      try {
                        return new URL(tab.url).host
                      } catch {
                        return address
                      }
                    })()
              }
              onFocus={(event) => {
                setFocused(true)
                setAddress(tab.url === 'about:blank' ? '' : tab.url)
                event.currentTarget.select()
              }}
              onBlur={() => setFocused(false)}
              onChange={(event) => setAddress(event.target.value)}
              className={`h-8 w-full rounded-full bg-secondary/80 px-3 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring ${focused || tab.url === 'about:blank' ? 'text-left' : 'text-center'}`}
            />
          )}
        </form>
        <Button
          size="icon-sm"
          variant="ghost"
          className="shrink-0 rounded-full bg-secondary/80"
          title="返回聊天"
          aria-label="返回聊天"
          onClick={onFocusChat}
        >
          <MessageCircle className="size-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              className="shrink-0 rounded-full bg-secondary/80"
              title="更多浏览器操作"
              aria-label="更多浏览器操作"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem onSelect={() => setFinding(true)}>
              <Search />
              在页面中查找
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <div className="flex items-center justify-between gap-1 px-2.5 py-1.5 text-xs">
              <span>缩放</span>
              <div className="flex items-center rounded-lg border border-border">
                <Button size="icon-sm" variant="ghost" aria-label="缩小" onClick={() => changeZoom(zoom - 0.1)}>
                  <ZoomOut className="size-3" />
                </Button>
                <button className="min-w-10 text-center tabular-nums" title="重置缩放" onClick={() => changeZoom(1)}>
                  {Math.round(zoom * 100)}%
                </button>
                <Button size="icon-sm" variant="ghost" aria-label="放大" onClick={() => changeZoom(zoom + 0.1)}>
                  <ZoomIn className="size-3" />
                </Button>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => menuCommand({ type: 'screenshot' })}>
              <Camera />
              截取屏幕截图
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => menuCommand({ type: 'annotate', enabled: true, region: true })}>
              <MousePointer2 />
              区域批注
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!editor || editor.tabId !== tab.id}
              onSelect={() => {
                if (editor) menuCommand({ type: 'restore-editor', annotation: editor })
              }}
            >
              <Pencil />
              继续未完成批注
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void command({ type: 'external' })}>
              <ExternalLink />
              在系统浏览器打开
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSettings('downloads')}>下载记录</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSettings('history')}>历史记录</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSettings('clear')}>清理浏览数据</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onSettings('general')}>
              <Settings />
              浏览器设置
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {saveError ? (
        <div role="alert" className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-destructive">
          <span>{saveError}</span>
          <Button size="sm" variant="outline" onClick={onRetrySave}>
            重试保存
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="shrink-0 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div ref={viewport} className="relative min-h-0 flex-1 bg-background">
        {preview && !tab.error && tab.url !== 'about:blank' ? (
          <img alt="网页预览" src={preview} className="pointer-events-none absolute inset-0 size-full object-fill" />
        ) : null}
        {tab.error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p role="alert" className="break-all text-sm text-destructive">
              {tab.error}
            </p>
            <Button variant="outline" onClick={() => void command({ type: 'reload' })}>
              重新加载
            </Button>
          </div>
        ) : tab.url === 'about:blank' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
            <Search className="size-9" />
            <p className="text-sm">输入网址，开始浏览</p>
            <p className="text-xs">选中网页元素后，可添加批注并加入当前对话。</p>
            {recent.length ? (
              <div className="mt-4 w-full space-y-2 text-left">
                <h3 className="text-xs">最近访问</h3>
                {recent.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => void command({ type: 'navigate', url: item.url })}
                    className="block w-full truncate rounded-lg bg-secondary/50 px-3 py-2 text-left text-xs hover:bg-secondary"
                    title={item.url}
                  >
                    {item.title || item.url}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
