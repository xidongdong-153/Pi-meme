import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Globe,
  MoreHorizontal,
  MousePointer2,
  Pencil,
  RefreshCw,
  Search,
  Settings,
  Square,
  X,
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
  saveError,
  onRetrySave,
}: {
  platform: BrowserPlatform
  tab: BrowserTab
  annotations: BrowserAnnotation[]
  editor?: BrowserAnnotation
  onSettings: (section?: 'general' | 'history' | 'downloads' | 'clear') => void
  saveError?: string
  onRetrySave?: () => void
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const addressInput = useRef<HTMLInputElement>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const findText = useRef('')
  const focusFindAfterMenu = useRef(false)
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
  const [query, setQuery] = useState('')
  const [findResult, setFindResult] = useState<{ active: number; matches: number } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const zoom = tab.zoom ?? 1
  const [menuZoom, setMenuZoom] = useState(zoom)
  const currentZoom = useRef(zoom)
  const zoomRequest = useRef(0)
  const previewRequest = useRef(0)
  const menuRequest = useRef(0)
  const menuPreviewReady = useRef(false)
  const [annotating, setAnnotating] = useState(false)
  useEffect(() => {
    if (!menuOpen) {
      currentZoom.current = zoom
      setMenuZoom(zoom)
    }
  }, [menuOpen, zoom])
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
  useLayoutEffect(() => {
    if (focused) addressInput.current?.select()
  }, [focused])
  useEffect(() => {
    findText.current = ''
    setQuery('')
    setFindResult(null)
    setFinding(false)
    void platform.command(tab.id, { type: 'find', text: '' }).catch(() => {})
  }, [platform, tab.id, tab.documentId])
  useEffect(() => {
    if (finding && !menuOpen) {
      findInput.current?.focus()
      findInput.current?.select()
    }
  }, [finding, menuOpen])
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
      if (event.type === 'find-result' && event.tabId === tab.id && event.text === findText.current)
        setFindResult({ active: event.active, matches: event.matches })
      if (event.type === 'browser-shortcut' && event.tabId === tab.id) {
        if (event.action === 'find') {
          setFinding(true)
          findInput.current?.focus()
          findInput.current?.select()
        } else if (event.action === 'address') {
          addressInput.current?.focus()
          addressInput.current?.select()
        } else {
          setFinding(false)
          findText.current = ''
          setQuery('')
          setFindResult(null)
          void platform.command(tab.id, { type: 'find', text: '' }).catch(() => {})
          void platform.command(tab.id, { type: 'focus' }).catch(() => {})
        }
      }
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
  const updatePreview = async (image: string | null, request: number) => {
    if (!image) return false
    const loaded = new Image()
    loaded.src = image
    try {
      await loaded.decode()
    } catch {
      return false
    }
    if (previewRequest.current !== request) return false
    setPreview(image)
    return true
  }
  const changeMenuOpen = (open: boolean) => {
    const request = ++menuRequest.current
    if (!open) {
      menuPreviewReady.current = false
      setMenuOpen(false)
      return
    }
    const imageRequest = ++previewRequest.current
    void platform
      .preview(tab.id)
      .then((image) => updatePreview(image, imageRequest))
      .then((ready) => {
        if (menuRequest.current !== request) return
        menuPreviewReady.current = ready
        requestAnimationFrame(() => {
          if (menuRequest.current === request) setMenuOpen(true)
        })
      })
      .catch((cause) => {
        if (menuRequest.current !== request) return
        setError(String(cause))
        setMenuOpen(true)
      })
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
        // 不截图的显隐更新不能使正在生成的缩放预览失效。
        const request = !bounds && !menuPreviewReady.current ? ++previewRequest.current : previewRequest.current
        void platform
          .present(tab.id, bounds, theme, colors, !menuPreviewReady.current)
          .then((image) => {
            if (!cancelled && image) void updatePreview(image, request)
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
  const changeZoom = async (value: number) => {
    const next = Math.round(Math.max(0.25, Math.min(3, value)) * 100) / 100
    const request = ++zoomRequest.current
    const imageRequest = ++previewRequest.current
    currentZoom.current = next
    setMenuZoom(next)
    try {
      setError('')
      await platform.command(tab.id, { type: 'zoom', value: next })
      if (zoomRequest.current !== request) return
      await updatePreview(await platform.preview(tab.id), imageRequest)
    } catch (cause) {
      if (zoomRequest.current !== request) return
      currentZoom.current = currentTab.current.zoom ?? 1
      setMenuZoom(currentZoom.current)
      setError(String(cause))
    }
  }
  const closeFind = () => {
    setFinding(false)
    findText.current = ''
    setQuery('')
    setFindResult(null)
    void command({ type: 'find', text: '' })
    void command({ type: 'focus' })
  }
  const find = (text: string, next = false, forward = true) => {
    findText.current = text
    setQuery(text)
    if (!next) setFindResult(null)
    void command({ type: 'find', text, next, forward })
  }
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.altKey) return
        if ((event.metaKey || event.ctrlKey) && !event.shiftKey) {
          if (event.key.toLowerCase() === 'f') {
            event.preventDefault()
            setFinding(true)
            findInput.current?.focus()
            findInput.current?.select()
          } else if (event.key.toLowerCase() === 'l') {
            event.preventDefault()
            addressInput.current?.focus()
            addressInput.current?.select()
          }
        }
      }}
    >
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
            className={narrow && !tab.canGoForward ? 'hidden' : undefined}
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
            if (address.trim()) void command({ type: 'navigate', url: address })
          }}
        >
          <input
            ref={addressInput}
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
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                if (event.key === 'Enter') event.preventDefault()
                return
              }
              if (event.key === 'Escape') {
                setAddress(tab.url === 'about:blank' ? '' : tab.url)
                event.currentTarget.blur()
                void command({ type: 'focus' })
              }
            }}
            className={`h-8 w-full rounded-full bg-secondary/80 px-3 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring ${focused || tab.url === 'about:blank' ? 'text-left' : 'text-center'}`}
          />
        </form>
        <DropdownMenu open={menuOpen} onOpenChange={changeMenuOpen}>
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
          <DropdownMenuContent
            align="end"
            side="bottom"
            className="w-64"
            onCloseAutoFocus={(event) => {
              if (!focusFindAfterMenu.current) return
              event.preventDefault()
              focusFindAfterMenu.current = false
              if (document.activeElement !== findInput.current) {
                findInput.current?.focus()
                findInput.current?.select()
              }
            }}
          >
            <DropdownMenuItem
              onSelect={() => {
                focusFindAfterMenu.current = true
                setFinding(true)
              }}
            >
              <Search />
              在页面中查找
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <div className="flex items-center justify-between gap-1 px-2.5 py-1.5 text-xs">
              <span>缩放</span>
              <div className="flex items-center rounded-lg border border-border">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="缩小"
                  disabled={menuZoom <= 0.25}
                  onClick={() => void changeZoom(currentZoom.current - 0.1)}
                >
                  <ZoomOut className="size-3" />
                </Button>
                <button
                  className="min-w-10 text-center tabular-nums"
                  title="重置缩放"
                  type="button"
                  onClick={() => void changeZoom(1)}
                >
                  {Math.round(menuZoom * 100)}%
                </button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="放大"
                  disabled={menuZoom >= 3}
                  onClick={() => void changeZoom(currentZoom.current + 0.1)}
                >
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
      {finding ? (
        <div
          role="search"
          aria-label="页内查找"
          className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-background px-2 no-drag"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.stopPropagation()
              closeFind()
            }
          }}
        >
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={findInput}
            aria-label="在页面中查找"
            placeholder="在页面中查找"
            value={query}
            maxLength={1000}
            className="h-8 min-w-0 flex-1 rounded-md bg-secondary/80 px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onChange={(event) => find(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                if (query) find(query, true, !event.shiftKey)
              }
            }}
          />
          <span
            role="status"
            className={`shrink-0 text-xs tabular-nums ${query && findResult?.matches === 0 ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {!query
              ? ''
              : !findResult
                ? '查找中…'
                : findResult.matches
                  ? `${findResult.active}/${findResult.matches}`
                  : '无匹配'}
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="上一个匹配"
            title="上一个匹配（Shift+Enter）"
            disabled={!query || !findResult?.matches}
            onClick={() => find(query, true, false)}
          >
            <ChevronUp className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="下一个匹配"
            title="下一个匹配（Enter）"
            disabled={!query || !findResult?.matches}
            onClick={() => find(query, true)}
          >
            <ChevronDown className="size-3.5" />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="关闭查找" title="关闭查找（Esc）" onClick={closeFind}>
            <X className="size-3.5" />
          </Button>
        </div>
      ) : null}
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
