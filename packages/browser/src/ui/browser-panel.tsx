import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
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
import type {
  BrowserAnnotation,
  BrowserCommand,
  BrowserPlatform,
  BrowserTab,
  BrowserHistory,
} from '@pi-meme/contracts/browser'

export function BrowserPanel({
  platform,
  tab,
  annotations,
  editor,
  onSettings,
  saveError,
  onRetrySave,
}: {
  platform: BrowserPlatform
  tab: BrowserTab
  annotations: BrowserAnnotation[]
  editor?: BrowserAnnotation
  onSettings: () => void
  saveError?: string
  onRetrySave?: () => void
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const currentTab = useRef(tab)
  currentTab.current = tab
  const [recent, setRecent] = useState<BrowserHistory[]>([])
  const [fullUrl, setFullUrl] = useState(false)
  const [focused, setFocused] = useState(false)
  const [address, setAddress] = useState(tab.url === 'about:blank' ? '' : tab.url)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [finding, setFinding] = useState(false)
  const [zoom, setZoom] = useState(1)
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
  useEffect(() => setZoom(tab.zoom ?? 1), [tab.zoom])
  useEffect(() => setAddress(tab.url === 'about:blank' ? '' : tab.url), [tab.url])
  const command = async (value: BrowserCommand) => {
    try {
      setError('')
      await platform.command(tab.id, value)
    } catch (cause) {
      setError(String(cause))
    }
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
      const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
      const next = JSON.stringify([bounds, theme, currentTab.current.error, currentTab.current.url])
      if (last !== next) {
        last = next
        void platform
          .present(tab.id, bounds, theme)
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
  const actions = [
    { title: '后退', icon: ArrowLeft, disabled: !tab.canGoBack, run: () => command({ type: 'back' }) },
    { title: '前进', icon: ArrowRight, disabled: !tab.canGoForward, run: () => command({ type: 'forward' }) },
    {
      title: tab.loading ? '停止加载' : '刷新',
      icon: tab.loading ? Square : RefreshCw,
      run: () => command({ type: tab.loading ? 'stop' : 'reload' }),
    },
  ]
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2 no-drag">
        {actions.map(({ title, icon: Icon, disabled, run }) => (
          <Button
            key={title}
            size="icon-sm"
            variant="ghost"
            title={title}
            aria-label={title}
            disabled={disabled}
            onClick={() => void run()}
          >
            <Icon className="size-3.5" />
          </Button>
        ))}
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            void command({ type: 'navigate', url: address })
          }}
        >
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
            className="h-8 w-full rounded-full bg-secondary px-3 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </form>
        <Button
          size="icon-sm"
          variant={annotating ? 'secondary' : 'ghost'}
          title="选择元素批注"
          aria-label="选择元素批注"
          disabled={tab.url === 'about:blank' || !!tab.error}
          onClick={() => {
            setAnnotating(!annotating)
            void command({ type: 'annotate', enabled: !annotating })
          }}
        >
          <MousePointer2 className="size-4" />
        </Button>
        <Button size="icon-sm" variant="ghost" title="浏览器设置" aria-label="浏览器设置" onClick={onSettings}>
          <Settings className="size-4" />
        </Button>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1 no-drag">
        <Button
          size="icon-sm"
          variant="ghost"
          title="继续未加入的批注"
          aria-label="继续未加入的批注"
          disabled={!editor || editor.tabId !== tab.id}
          onClick={() => {
            if (editor) void command({ type: 'restore-editor', annotation: editor })
          }}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setFinding(!finding)}>
          <Search className="size-3" />
          查找
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void command({ type: 'screenshot' })}>
          <Camera className="size-3" />
          截图
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setAnnotating(true)
            void command({ type: 'annotate', enabled: true, region: true })
          }}
        >
          区域批注
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="缩小"
          onClick={() => {
            const value = Math.max(0.25, zoom - 0.1)
            setZoom(value)
            void command({ type: 'zoom', value })
          }}
        >
          <ZoomOut className="size-3" />
        </Button>
        <button
          className="text-xs tabular-nums"
          title="重置缩放"
          onClick={() => {
            setZoom(1)
            void command({ type: 'zoom', value: 1 })
          }}
        >
          {Math.round(zoom * 100)}%
        </button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="放大"
          onClick={() => {
            const value = Math.min(3, zoom + 0.1)
            setZoom(value)
            void command({ type: 'zoom', value })
          }}
        >
          <ZoomIn className="size-3" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          title="在系统浏览器打开"
          aria-label="在系统浏览器打开"
          onClick={() => void command({ type: 'external' })}
        >
          <ExternalLink className="size-3" />
        </Button>
        {finding ? (
          <input
            autoFocus
            aria-label="在页面中查找"
            className="h-7 w-40 rounded bg-secondary px-2 text-xs"
            placeholder="在页面中查找"
            onChange={(event) => void command({ type: 'find', text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setFinding(false)
                void command({ type: 'find', text: '' })
              }
            }}
          />
        ) : null}
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
