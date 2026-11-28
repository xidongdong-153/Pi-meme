import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  MoreHorizontal,
  MousePointer2,
  Pencil,
  RefreshCw,
  Search,
  Settings,
  SquareDashed,
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
  BrowserNavigationEntry,
  BrowserPlatform,
  BrowserSnapshot,
  BrowserTab,
  BrowserViewMode,
} from '@pi-meme/contracts/browser'
import type { ThemeColors } from '@pi-meme/contracts/settings'
import { BrowserFavicon, BrowserOmnibox } from './browser-omnibox'

export { BrowserFavicon }

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

export function BrowserPanel({
  platform,
  tab,
  openTabs = [],
  onSwitchTab,
  annotations,
  editor,
  viewMode = 'split',
  onSettings,
  saveError,
  onRetrySave,
}: {
  platform: BrowserPlatform
  tab: BrowserTab
  openTabs?: BrowserTab[]
  onSwitchTab?: (tabId: string) => void
  annotations: BrowserAnnotation[]
  editor?: BrowserAnnotation
  viewMode?: BrowserViewMode
  onSettings: (section?: 'general' | 'history' | 'downloads' | 'clear') => void
  saveError?: string
  onRetrySave?: () => void
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const addressInput = useRef<HTMLInputElement>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const navGroupRef = useRef<HTMLDivElement>(null)
  const findText = useRef('')
  const focusFindAfterMenu = useRef(false)
  const longPressTimer = useRef<number | undefined>(undefined)
  const longPressed = useRef(false)
  const currentTab = useRef(tab)
  currentTab.current = tab
  const currentAnnotations = useRef(annotations)
  currentAnnotations.current = annotations
  const currentViewMode = useRef(viewMode)
  currentViewMode.current = viewMode

  const [snapshot, setSnapshot] = useState<BrowserSnapshot>()
  const [address, setAddress] = useState(tab.url === 'about:blank' ? '' : tab.url)
  const [hoverUrl, setHoverUrl] = useState('')
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const [findResult, setFindResult] = useState<{ active: number; matches: number } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [omniboxOpen, setOmniboxOpen] = useState(false)
  const [navHistory, setNavHistory] = useState<{
    direction: 'back' | 'forward'
    entries: BrowserNavigationEntry[]
  } | null>(null)
  const [narrow, setNarrow] = useState(false)
  const zoom = tab.zoom ?? 1
  const [menuZoom, setMenuZoom] = useState(zoom)
  const currentZoom = useRef(zoom)
  const zoomRequest = useRef(0)
  const previewRequest = useRef(0)
  const menuRequest = useRef(0)
  const menuPreviewReady = useRef(false)
  const [annotating, setAnnotating] = useState(false)

  const recent = snapshot?.history.slice(0, 6) ?? []
  const activeDownloads = snapshot?.downloads.filter((item) => item.state === 'progressing').length ?? 0

  useEffect(() => {
    if (!menuOpen) {
      currentZoom.current = zoom
      setMenuZoom(zoom)
    }
  }, [menuOpen, zoom])

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      void platform
        .snapshot()
        .then((value) => {
          if (!cancelled) setSnapshot(value)
        })
        .catch(() => {})
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

  useEffect(() => setAddress(tab.url === 'about:blank' ? '' : tab.url), [tab.url])

  useEffect(() => {
    findText.current = ''
    setQuery('')
    setFindResult(null)
    setFinding(false)
    setHoverUrl('')
    setNavHistory(null)
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
      if (event.type === 'target-url' && event.tabId === tab.id) setHoverUrl(event.url)
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

  useEffect(() => {
    if (!navHistory) return
    const onPointerDown = (event: PointerEvent) => {
      if (navGroupRef.current?.contains(event.target as Node | null)) return
      setNavHistory(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setNavHistory(null)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [navHistory])

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

  const updatePreview = useCallback(async (image: string | null, request: number) => {
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
  }, [])

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

  const handleOmniboxOpenChange = useCallback(
    (open: boolean) => {
      setOmniboxOpen(open)
      if (!open) return
      const imageRequest = ++previewRequest.current
      void platform
        .preview(tab.id)
        .then((image) => updatePreview(image, imageRequest))
        .catch(() => {})
    },
    [platform, tab.id, updatePreview],
  )

  const openNavHistory = async (direction: 'back' | 'forward') => {
    const imageRequest = ++previewRequest.current
    const [image, stack] = await Promise.all([
      platform.preview(tab.id).catch(() => null),
      platform.navigationHistory(tab.id).catch(() => ({ index: -1, entries: [] })),
    ])
    await updatePreview(image, imageRequest)
    if (stack.index < 0 || !stack.entries.length) return
    const entries =
      direction === 'back' ? stack.entries.slice(0, stack.index).reverse() : stack.entries.slice(stack.index + 1)
    if (entries.length) setNavHistory({ direction, entries })
  }

  const startLongPress = (direction: 'back' | 'forward', enabled: boolean) => {
    longPressed.current = false
    window.clearTimeout(longPressTimer.current)
    if (!enabled) return
    longPressTimer.current = window.setTimeout(() => {
      longPressed.current = true
      void openNavHistory(direction)
    }, 400)
  }

  const cancelLongPress = () => {
    window.clearTimeout(longPressTimer.current)
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
        '[role="dialog"][data-state="open"], [role="alertdialog"], [data-radix-popper-content-wrapper], [data-browser-popover="open"]',
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
        const freezePreview = menuPreviewReady.current || omniboxOpen || Boolean(navHistory)
        const request = !bounds && !freezePreview ? ++previewRequest.current : previewRequest.current
        void platform
          .present(tab.id, bounds, theme, colors, !freezePreview)
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
        void platform.command(tab.id, { type: 'view-mode', mode: currentViewMode.current }).catch(() => {})
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
  }, [platform, tab.id, tab.owner, omniboxOpen, navHistory, updatePreview])

  useEffect(() => {
    void platform.command(tab.id, { type: 'view-mode', mode: viewMode }).catch(() => {})
  }, [platform, tab.id, viewMode])

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
        if (navHistory && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setNavHistory(null)
          return
        }
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
      <div className="relative flex h-12 shrink-0 items-center gap-1.5 border-b border-border bg-background px-2 no-drag">
        <div ref={navGroupRef} className="relative flex h-8 shrink-0 items-center rounded-full bg-secondary/80 px-0.5">
          <TooltipHint content="后退（长按或右键查看历史）">
            <span className="inline-flex">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="后退"
                className="rounded-full hover:bg-transparent hover:opacity-75"
                disabled={!tab.canGoBack}
                onPointerDown={() => startLongPress('back', tab.canGoBack)}
                onPointerUp={cancelLongPress}
                onPointerLeave={cancelLongPress}
                onPointerCancel={cancelLongPress}
                onContextMenu={(event) => {
                  if (!tab.canGoBack) return
                  event.preventDefault()
                  void openNavHistory('back')
                }}
                onClick={() => {
                  if (longPressed.current) {
                    longPressed.current = false
                    return
                  }
                  void command({ type: 'back' })
                }}
              >
                <ArrowLeft className="size-4" />
              </Button>
            </span>
          </TooltipHint>
          <TooltipHint content="前进（长按或右键查看历史）">
            <span className={narrow && !tab.canGoForward ? 'hidden' : 'inline-flex'}>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="前进"
                className="rounded-full hover:bg-transparent hover:opacity-75"
                disabled={!tab.canGoForward}
                onPointerDown={() => startLongPress('forward', tab.canGoForward)}
                onPointerUp={cancelLongPress}
                onPointerLeave={cancelLongPress}
                onPointerCancel={cancelLongPress}
                onContextMenu={(event) => {
                  if (!tab.canGoForward) return
                  event.preventDefault()
                  void openNavHistory('forward')
                }}
                onClick={() => {
                  if (longPressed.current) {
                    longPressed.current = false
                    return
                  }
                  void command({ type: 'forward' })
                }}
              >
                <ArrowRight className="size-4" />
              </Button>
            </span>
          </TooltipHint>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <TooltipHint content={tab.loading ? '停止加载' : '刷新'}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={tab.loading ? '停止加载' : '刷新'}
              className="rounded-full hover:bg-transparent hover:opacity-75"
              onClick={() => void command({ type: tab.loading ? 'stop' : 'reload' })}
            >
              {tab.loading ? <X className="size-3.5" /> : <RefreshCw className="size-3.5" />}
            </Button>
          </TooltipHint>

          {navHistory ? (
            <div
              role="menu"
              data-browser-popover="open"
              aria-label={navHistory.direction === 'back' ? '后退历史' : '前进历史'}
              className="absolute left-0 top-10 z-50 max-h-72 w-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl"
            >
              {navHistory.entries.map((entry) => (
                <button
                  key={`${entry.index}:${entry.url}`}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setNavHistory(null)
                    void command({ type: 'go-to-index', index: entry.index })
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-secondary"
                >
                  <BrowserFavicon className="size-3.5 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{entry.title || entry.url}</p>
                    <p className="truncate text-[10px] text-muted-foreground">{entry.url}</p>
                  </div>
                </button>
              ))}
            </div>
          ) : null}
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

        <BrowserOmnibox
          variant="toolbar"
          platform={platform}
          value={address}
          onChange={setAddress}
          currentUrl={tab.url}
          hoverUrl={hoverUrl}
          fullUrl={snapshot?.settings.fullUrl ?? false}
          zoom={zoom}
          onResetZoom={() => void changeZoom(1)}
          searchEngine={snapshot?.settings.search}
          searchSuggestionsEnabled={snapshot?.settings.searchSuggestions !== false}
          history={snapshot?.history}
          searchQueries={snapshot?.searchQueries}
          openTabs={openTabs}
          currentTabId={tab.id}
          placeholder="搜索或输入网址"
          inputRef={addressInput}
          onSubmitUrl={(input) => void command({ type: 'navigate', url: input })}
          onSwitchTab={onSwitchTab}
          onRemoveSearchQuery={(q) => void platform.searchQuery({ remove: q })}
          onEscapeToPage={() => void command({ type: 'focus' })}
          onDropdownOpenChange={handleOmniboxOpenChange}
        />

        {activeDownloads > 0 ? (
          <TooltipHint content={`正在下载 ${activeDownloads} 个文件`}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`正在下载 ${activeDownloads} 个文件`}
              onClick={() => onSettings('downloads')}
              className="relative shrink-0 rounded-full bg-secondary/80 text-primary"
            >
              <Download className="size-4 animate-pulse motion-reduce:animate-none" />
              <span className="absolute -right-0.5 -top-0.5 inline-flex size-3.5 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground tabular-nums">
                {activeDownloads}
              </span>
            </Button>
          </TooltipHint>
        ) : null}

        <DropdownMenu open={menuOpen} onOpenChange={changeMenuOpen}>
          <TooltipHint content="更多浏览器操作">
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                className="shrink-0 rounded-full bg-secondary/80"
                aria-label="更多浏览器操作"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipHint>
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
                <TooltipHint content="重置缩放">
                  <button
                    className="min-w-10 text-center tabular-nums"
                    type="button"
                    onClick={() => void changeZoom(1)}
                  >
                    {Math.round(menuZoom * 100)}%
                  </button>
                </TooltipHint>
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
              <SquareDashed />
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

        {tab.loading ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-primary/15"
          >
            <div className="h-full w-2/5 animate-pulse rounded-full bg-primary motion-reduce:w-full motion-reduce:animate-none" />
          </div>
        ) : null}
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
          <TooltipHint content="上一个匹配（Shift+Enter）">
            <span className="inline-flex">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="上一个匹配"
                disabled={!query || !findResult?.matches}
                onClick={() => find(query, true, false)}
              >
                <ChevronUp className="size-3.5" />
              </Button>
            </span>
          </TooltipHint>
          <TooltipHint content="下一个匹配（Enter）">
            <span className="inline-flex">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="下一个匹配"
                disabled={!query || !findResult?.matches}
                onClick={() => find(query, true)}
              >
                <ChevronDown className="size-3.5" />
              </Button>
            </span>
          </TooltipHint>
          <TooltipHint content="关闭查找（Esc）">
            <Button size="icon-sm" variant="ghost" aria-label="关闭查找" onClick={closeFind}>
              <X className="size-3.5" />
            </Button>
          </TooltipHint>
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
          <div className="flex h-full flex-col items-center justify-center p-6">
            <div className="w-full max-w-sm rounded-2xl border border-border/60 bg-card/80 p-6 text-center shadow-sm">
              <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <AlertCircle className="size-5" />
              </div>
              <h3 className="text-sm font-medium text-foreground">无法访问此页面</h3>
              <p role="alert" className="mt-1.5 break-all text-xs leading-relaxed text-muted-foreground">
                {tab.error}
              </p>
              <div className="mt-5 flex items-center justify-center gap-2">
                <Button size="sm" variant="default" onClick={() => void command({ type: 'reload' })}>
                  <RefreshCw className="size-3.5" />
                  重新加载
                </Button>
                {/^https?:/.test(tab.url) ? (
                  <Button size="sm" variant="outline" onClick={() => void command({ type: 'external' })}>
                    <ExternalLink className="size-3.5" />
                    在系统浏览器打开
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : tab.url === 'about:blank' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
            <Search className="size-9" />
            <p className="text-sm">输入网址，开始浏览</p>
            <p className="text-xs">选中网页元素后，可添加批注并加入当前对话。</p>
            {recent.length ? (
              <div className="mt-4 w-full max-w-md space-y-2 text-left">
                <h3 className="text-xs">最近访问</h3>
                {recent.map((item) => (
                  <TooltipHint key={item.id} content={item.url}>
                    <button
                      type="button"
                      onClick={() => void command({ type: 'navigate', url: item.url })}
                      className="flex w-full items-center gap-2 truncate rounded-lg bg-secondary/50 px-3 py-2 text-left text-xs hover:bg-secondary"
                    >
                      <BrowserFavicon src={item.favicon} className="size-3.5" />
                      <span className="truncate">{item.title || item.url}</span>
                    </button>
                  </TooltipHint>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
