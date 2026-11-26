import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  BrowserAnnotationMode,
  BrowserOverlayAction,
  BrowserOverlayAnnotationItem,
  BrowserOverlayPlatform,
  BrowserOverlayState,
  BrowserSettings,
} from '@pi-meme/contracts/browser'
import {
  annotationEmptyComment,
  annotationSourceLabel,
  annotationTargetLabel,
} from '@pi-meme/contracts/browser-annotations'
import { Button } from '@pi-meme/ui/components/ui/button'
import { cn } from '@pi-meme/ui/lib/utils'
import {
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  GripVertical,
  MessageSquare,
  MoreHorizontal,
  MousePointer2,
  SlidersHorizontal,
  SquareDashed,
  Trash2,
  X,
} from 'lucide-react'

const propertyNames: Record<string, string> = {
  color: '文本颜色',
  'background-color': '背景颜色',
  opacity: '透明度',
  'font-family': '字体',
  'font-size': '字号',
  'font-weight': '字重',
  padding: '内边距',
  'border-radius': '圆角',
  'border-color': '边框颜色',
  'border-width': '边框宽度',
}

const screenshotLabels: Record<BrowserSettings['screenshots'], string> = {
  element: '元素截图',
  viewport: '整页视口',
  none: '不附截图',
}

const colorProperties = new Set(['color', 'background-color', 'border-color'])

type ToolbarPanel = 'none' | 'list' | 'more'

export function BrowserOverlay({ platform }: { platform: BrowserOverlayPlatform }) {
  return <BrowserOverlayContent platform={platform} />
}

function BrowserOverlayContent({ platform }: { platform: BrowserOverlayPlatform }) {
  const [state, setState] = useState<BrowserOverlayState>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [panel, setPanel] = useState<ToolbarPanel>('none')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [capturedFlash, setCapturedFlash] = useState(false)
  const [screenshotPickerOpen, setScreenshotPickerOpen] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const commentRef = useRef<HTMLTextAreaElement>(null)
  const editorCardRef = useRef<HTMLDivElement>(null)
  const toolbarContainerRef = useRef<HTMLDivElement>(null)
  const toolbarPillRef = useRef<HTMLDivElement>(null)
  const requestedEditorHeight = useRef(0)
  const requestedToolbarSize = useRef({ width: 0, height: 0 })
  const drag = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null)
  const dragFrame = useRef(0)
  const spaceHeld = useRef(false)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const release = platform.onState(setState)
    void platform
      .state()
      .then(setState)
      .catch((cause) => setError(String(cause)))
    return () => {
      release()
      cancelAnimationFrame(dragFrame.current)
      clearTimeout(flashTimer.current)
      clearTimeout(copyTimer.current)
    }
  }, [platform])

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    for (const element of [document.documentElement, document.body, document.getElementById('root')]) {
      if (element) Object.assign(element.style, { height: '100%', width: '100%', minWidth: '0', overflow: 'hidden' })
    }
    document.documentElement.style.colorScheme = state?.theme ?? 'dark'
    document.documentElement.dataset.appearance = state?.theme ?? 'dark'
    if (state?.colors)
      for (const [key, value] of Object.entries(state.colors))
        document.documentElement.style.setProperty(`--color-${key}`, value)
  }, [state?.theme, state?.colors])

  useEffect(() => {
    if (state?.kind !== 'toolbar') return
    const restoreOriginal = () => {
      if (spaceHeld.current) spaceHeld.current = false
      void platform.action({ type: 'original', pressed: false }).catch(() => {})
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (confirmDiscard) {
          setConfirmDiscard(false)
        } else if (panel !== 'none') {
          setPanel('none')
          void platform.action({ type: 'toolbar-menu', open: false }).catch(() => {})
        } else {
          void platform.action({ type: 'exit' }).catch((cause) => setError(String(cause)))
        }
        return
      }
      if ((event.code === 'Space' || event.key === ' ') && !event.repeat && panel === 'none') {
        const target = event.target as HTMLElement | null
        if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
        event.preventDefault()
        spaceHeld.current = true
        void platform.action({ type: 'original', pressed: true }).catch(() => {})
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if ((event.code === 'Space' || event.key === ' ') && spaceHeld.current) restoreOriginal()
    }
    window.addEventListener('blur', restoreOriginal)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('blur', restoreOriginal)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [platform, state?.kind, panel, confirmDiscard])

  useLayoutEffect(() => {
    if (state) void platform.action({ type: 'ready' }).catch((cause) => setError(String(cause)))
  }, [platform, state?.kind])

  useEffect(() => {
    if (state?.kind === 'toolbar' && state.count === 0) {
      setConfirmDiscard(false)
      if (panel === 'list') {
        setPanel('none')
        void platform.action({ type: 'toolbar-menu', open: false }).catch(() => {})
      }
    }
  }, [platform, state?.kind, state?.count, panel])

  useLayoutEffect(() => {
    requestedEditorHeight.current = 0
    setComment(state?.annotation?.comment ?? '')
    setScreenshotPickerOpen(false)
    setError('')
  }, [state?.annotation?.id])

  useLayoutEffect(() => {
    if (state?.kind !== 'editor') return
    const input = commentRef.current
    if (!input) return
    input.style.height = '0px'
    const nextHeight = Math.min(144, Math.max(48, input.scrollHeight))
    input.style.height = `${nextHeight}px`
  }, [comment, state?.annotation?.id, state?.kind, state?.expanded])

  useEffect(() => {
    if (state?.kind !== 'editor') return
    const card = editorCardRef.current
    if (!card) return
    const report = () => {
      const height = Math.max(112, Math.ceil(card.getBoundingClientRect().height + 8))
      if (requestedEditorHeight.current === height) return
      requestedEditorHeight.current = height
      void platform.action({ type: 'resize-editor', height }).catch(() => {})
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(card)
    return () => observer.disconnect()
  }, [platform, state?.kind, state?.annotation?.id, state?.expanded, screenshotPickerOpen, error, state?.error])

  useLayoutEffect(() => {
    if (state?.kind !== 'toolbar') return
    const container = toolbarContainerRef.current
    if (!container) return
    const report = () => {
      const containerRect = container.getBoundingClientRect()
      const pillWidth = toolbarPillRef.current?.scrollWidth ?? 0
      const naturalWidth = Math.max(container.scrollWidth, containerRect.width, pillWidth)
      const naturalHeight = Math.max(container.scrollHeight, containerRect.height)
      const width = Math.max(200, Math.ceil(naturalWidth + 16))
      const height = Math.max(48, Math.ceil(naturalHeight + 12))
      if (requestedToolbarSize.current.width === width && requestedToolbarSize.current.height === height) return
      requestedToolbarSize.current = { width, height }
      void platform.action({ type: 'resize-toolbar', width, height }).catch(() => {})
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(container)
    if (toolbarPillRef.current) observer.observe(toolbarPillRef.current)
    return () => observer.disconnect()
  }, [
    platform,
    state?.kind,
    state?.count,
    state?.mode,
    state?.viewMode,
    state?.original,
    state?.viewportWidth,
    panel,
    confirmDiscard,
    error,
  ])

  const runAction = async (value: BrowserOverlayAction) => {
    if (pending) return
    setPending(true)
    setError('')
    try {
      await platform.action(value)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setPending(false)
    }
  }

  const togglePanel = (next: ToolbarPanel) => {
    const resolved = panel === next ? 'none' : next
    setConfirmDiscard(false)
    setPanel(resolved)
    void platform.action({ type: 'toolbar-menu', open: resolved !== 'none' }).catch(() => {})
  }

  const closePanel = () => {
    setConfirmDiscard(false)
    if (panel !== 'none') {
      setPanel('none')
      void platform.action({ type: 'toolbar-menu', open: false }).catch(() => {})
    }
  }

  const moveToolbar = (screenX: number, screenY: number) => {
    if (!drag.current) return
    const next = {
      type: 'move-toolbar' as const,
      x: drag.current.offsetX + screenX - drag.current.x,
      y: drag.current.offsetY + screenY - drag.current.y,
    }
    cancelAnimationFrame(dragFrame.current)
    dragFrame.current = requestAnimationFrame(
      () => void platform.action(next).catch((cause) => setError(String(cause))),
    )
  }

  if (!state) return null

  if (state.kind === 'toolbar') {
    const viewportWidth = state.viewportWidth ?? 900
    const compact = viewportWidth < 580
    const listWidth = Math.max(240, Math.min(368, viewportWidth - 20))
    const currentItems = state.items.filter((item) => item.isCurrentPage)
    const otherItems = state.items.filter((item) => !item.isCurrentPage)
    const modeSwitch = (target: BrowserAnnotationMode) => {
      if (state.mode === target) return
      void runAction({ type: 'mode', mode: target })
    }
    const handleScreenshot = () => {
      void runAction({ type: 'screenshot' }).then(() => {
        setCapturedFlash(true)
        clearTimeout(flashTimer.current)
        flashTimer.current = setTimeout(setCapturedFlash, 900, false)
      })
    }

    if (state.original) {
      return (
        <div className="flex h-full w-full items-end justify-center bg-transparent p-1 text-foreground">
          <div
            ref={toolbarContainerRef}
            className="flex h-9 items-center gap-2 rounded-xl border border-border/70 bg-card/85 px-3 text-xs text-muted-foreground shadow-xl"
          >
            <Eye className="size-3.5 text-primary" />
            <span>正在查看原始页面，松开 Space 返回批注</span>
          </div>
        </div>
      )
    }

    return (
      <div className="flex h-full w-full flex-col items-center justify-end bg-transparent p-1 text-foreground">
        <div ref={toolbarContainerRef} className="flex w-max flex-col items-center gap-2">
          {panel === 'list' && state.count > 0 ? (
            <div
              role="region"
              aria-label="已收集批注清单"
              style={{ width: listWidth }}
              className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-xl"
            >
              <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2 text-xs">
                {confirmDiscard ? (
                  <>
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      清空当前会话全部 {state.count} 条批注？
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button size="xs" variant="ghost" onClick={() => setConfirmDiscard(false)}>
                        取消
                      </Button>
                      <Button
                        size="xs"
                        variant="destructive"
                        disabled={pending}
                        onClick={() => {
                          setConfirmDiscard(false)
                          closePanel()
                          void runAction({ type: 'discard' })
                        }}
                      >
                        确认清空
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="font-medium text-foreground">已收集 {state.count} 条批注</span>
                    <button
                      type="button"
                      className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-destructive"
                      onClick={() => setConfirmDiscard(true)}
                    >
                      清空全部
                    </button>
                  </>
                )}
              </div>
              <div className="max-h-64 overflow-y-auto py-1">
                {currentItems.length > 0 ? (
                  <div>
                    <div className="px-3 py-1 text-[11px] font-medium text-muted-foreground">
                      当前页面（{currentItems.length}）
                    </div>
                    <div className="divide-y divide-border/40">
                      {currentItems.map((item) => (
                        <ToolbarListItem
                          key={item.id}
                          item={item}
                          disabled={pending}
                          onFocus={() => {
                            closePanel()
                            void runAction({ type: 'focus-marker', id: item.id })
                          }}
                          onRemove={() => void runAction({ type: 'remove', id: item.id })}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                {otherItems.length > 0 ? (
                  <div className={currentItems.length > 0 ? 'mt-1 border-t border-border/60 pt-1' : undefined}>
                    <div className="px-3 py-1 text-[11px] font-medium text-muted-foreground">
                      其他页面 / 标签（{otherItems.length}）
                    </div>
                    <div className="divide-y divide-border/40">
                      {otherItems.map((item) => (
                        <ToolbarListItem
                          key={item.id}
                          item={item}
                          disabled={pending}
                          onRemove={() => void runAction({ type: 'remove', id: item.id })}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {panel === 'more' ? (
            <div
              role="menu"
              aria-label="更多批注操作"
              className="w-52 overflow-hidden rounded-xl border border-border/70 bg-card p-1 text-xs shadow-xl"
            >
              {compact ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-secondary"
                    onClick={() => {
                      closePanel()
                      handleScreenshot()
                    }}
                  >
                    <Camera className="size-3.5 text-muted-foreground" />
                    <span>整页截屏</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-secondary"
                    onClick={() => {
                      closePanel()
                      void runAction({ type: 'hide', hidden: !state.hidden })
                    }}
                  >
                    {state.hidden ? (
                      <Eye className="size-3.5 text-primary" />
                    ) : (
                      <EyeOff className="size-3.5 text-muted-foreground" />
                    )}
                    <span>{state.hidden ? '显示标记点' : '隐藏标记点'}</span>
                  </button>
                  {state.viewMode === 'unified' && state.count > 0 ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-secondary"
                      onClick={() => {
                        closePanel()
                        void runAction({ type: 'open-chat' })
                      }}
                    >
                      <MessageSquare className="size-3.5 text-muted-foreground" />
                      <span>去对话补充</span>
                    </button>
                  ) : null}
                  <div className="my-1 h-px bg-border/60" />
                </>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-secondary"
                onPointerDown={() => void platform.action({ type: 'original', pressed: true })}
                onPointerUp={() => void platform.action({ type: 'original', pressed: false })}
                onPointerCancel={() => void platform.action({ type: 'original', pressed: false })}
                onPointerLeave={() => void platform.action({ type: 'original', pressed: false })}
              >
                <span className="flex items-center gap-2">
                  <Eye className="size-3.5 text-muted-foreground" />
                  <span>按住查看原页面</span>
                </span>
                <kbd className="rounded border border-border/70 bg-secondary px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                  Space
                </kbd>
              </button>
            </div>
          ) : null}

          <div
            ref={toolbarPillRef}
            className="flex h-10 w-max items-center gap-1 rounded-xl border border-border/70 bg-card px-1.5 shadow-xl"
          >
            <button
              type="button"
              aria-label="拖动批注工具条"
              className="flex h-7 w-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
              onPointerDown={(event) => {
                drag.current = {
                  x: event.screenX,
                  y: event.screenY,
                  offsetX: state.toolbarOffset.x,
                  offsetY: state.toolbarOffset.y,
                }
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={(event) => moveToolbar(event.screenX, event.screenY)}
              onPointerUp={(event) => {
                moveToolbar(event.screenX, event.screenY)
                drag.current = null
              }}
              onPointerCancel={() => (drag.current = null)}
            >
              <GripVertical className="size-3.5" />
            </button>

            <div
              role="group"
              aria-label="选取模式"
              className="flex h-7 shrink-0 items-center rounded-lg bg-secondary/75 p-0.5"
            >
              <button
                type="button"
                aria-label="点选元素"
                aria-pressed={state.mode === 'element'}
                className={cn(
                  'flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors',
                  state.mode === 'element'
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => modeSwitch('element')}
              >
                <MousePointer2 className="size-3.5 shrink-0" />
                {compact ? null : <span>点选</span>}
              </button>
              <button
                type="button"
                aria-label="框选区域"
                aria-pressed={state.mode === 'region'}
                className={cn(
                  'flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors',
                  state.mode === 'region'
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => modeSwitch('region')}
              >
                <SquareDashed className="size-3.5 shrink-0" />
                {compact ? null : <span>框选</span>}
              </button>
            </div>

            <span className="mx-0.5 h-4 w-px shrink-0 bg-border/70" />

            {state.count > 0 ? (
              <button
                type="button"
                aria-expanded={panel === 'list'}
                aria-label={`查看已收集的 ${state.count} 条批注`}
                className={cn(
                  'flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors tabular-nums',
                  panel === 'list' ? 'bg-primary/15 text-primary' : 'text-foreground hover:bg-secondary/80',
                )}
                onClick={() => togglePanel('list')}
              >
                <span className="whitespace-nowrap">已选 {state.count} 条</span>
                {panel === 'list' ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
              </button>
            ) : (
              <span className="min-w-0 truncate px-1.5 text-xs text-muted-foreground">
                {state.mode === 'region' ? '拖动框选区域' : '点击页面元素'}
              </span>
            )}

            {!compact ? (
              <>
                <span className="mx-0.5 h-4 w-px shrink-0 bg-border/70" />
                <Button
                  size="icon-sm"
                  className="size-7 shrink-0 rounded-lg"
                  variant="ghost"
                  aria-label="整页截屏"
                  disabled={pending}
                  onClick={handleScreenshot}
                >
                  {capturedFlash ? <Check className="size-3.5 text-primary" /> : <Camera className="size-3.5" />}
                </Button>
                <Button
                  size="icon-sm"
                  className={cn('size-7 shrink-0 rounded-lg', state.hidden && 'bg-primary/15 text-primary')}
                  variant="ghost"
                  aria-label={state.hidden ? '显示标记点' : '隐藏标记点'}
                  aria-pressed={state.hidden}
                  onClick={() => void runAction({ type: 'hide', hidden: !state.hidden })}
                >
                  {state.hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </Button>
              </>
            ) : null}

            <Button
              size="icon-sm"
              className={cn('size-7 shrink-0 rounded-lg', panel === 'more' && 'bg-secondary text-foreground')}
              variant="ghost"
              aria-label="更多批注操作"
              aria-expanded={panel === 'more'}
              onClick={() => togglePanel('more')}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>

            <span className="mx-0.5 h-4 w-px shrink-0 bg-border/70" />

            {state.viewMode === 'unified' && state.count > 0 && !compact ? (
              <Button
                size="xs"
                variant="ghost"
                className="h-7 shrink-0 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
                disabled={pending}
                onClick={() => {
                  closePanel()
                  void runAction({ type: 'open-chat' })
                }}
              >
                去对话
              </Button>
            ) : null}

            <Button
              size="xs"
              className="h-7 shrink-0 rounded-lg px-2.5 text-xs"
              disabled={pending || (!state.count && !state.annotation)}
              onClick={() => {
                closePanel()
                void runAction({ type: 'submit' })
              }}
            >
              发送
            </Button>

            <Button
              size="icon-sm"
              className="size-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
              variant="ghost"
              aria-label="退出批注"
              onClick={() => {
                closePanel()
                void runAction({ type: 'exit' })
              }}
            >
              <X className="size-3.5" />
            </Button>
          </div>

          {error ? (
            <p role="alert" className="max-w-full truncate rounded-lg bg-card px-2 py-0.5 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    )
  }

  const annotation = state.annotation
  const properties = annotation?.kind === 'element' ? (annotation.styles ?? {}) : {}
  const activeError = error || state.error || ''
  const targetName = annotation ? annotationTargetLabel(annotation) : '区域选区'
  const dimensions = annotation ? `${Math.round(annotation.rect.width)}×${Math.round(annotation.rect.height)}` : ''
  const markerNumber = state.markerNumber ?? state.count + 1
  const hasComment = comment.trim().length > 0
  const saveLabel = state.editing ? '保存' : hasComment ? '添加' : '仅标记'
  const screenshotMode = state.screenshot

  const copyProperty = (key: string, value: string) => {
    if (!value) return
    void navigator.clipboard?.writeText(value).catch(() => {})
    setCopiedKey(key)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(setCopiedKey, 1000, null)
  }

  return (
    <div className="h-full w-full bg-transparent p-1 text-foreground">
      <div
        ref={editorCardRef}
        className="flex flex-col overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xl"
      >
        <div className="flex items-center gap-1.5 border-b border-border/50 px-3 py-2">
          <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 px-1.5 text-[11px] font-semibold tabular-nums text-primary">
            {markerNumber}
          </span>
          <span className="min-w-0 truncate font-mono text-xs text-foreground">{targetName}</span>
          {dimensions ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{dimensions}</span>
          ) : null}
          <span className="min-w-0 flex-1" />
          <button
            type="button"
            aria-label="切换批注截图方式"
            aria-expanded={screenshotPickerOpen}
            className={cn(
              'inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors',
              screenshotPickerOpen
                ? 'bg-primary/15 text-primary'
                : 'bg-secondary/75 text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setScreenshotPickerOpen((open) => !open)}
          >
            <Camera className="size-3 shrink-0" />
            <span>{screenshotLabels[screenshotMode]}</span>
          </button>
          {annotation?.kind === 'element' ? (
            <Button
              size="icon-sm"
              variant="ghost"
              className={cn('size-6 shrink-0 rounded-md', state.expanded && 'bg-primary/15 text-primary')}
              aria-label="查看元素属性"
              aria-expanded={state.expanded}
              onClick={() => void runAction({ type: 'expand', expanded: !state.expanded })}
            >
              <SlidersHorizontal className="size-3.5" />
            </Button>
          ) : null}
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-6 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
            aria-label="取消批注"
            onClick={() => void runAction({ type: 'cancel' })}
          >
            <X className="size-3.5" />
          </Button>
        </div>

        {screenshotPickerOpen ? (
          <div className="flex items-center justify-between gap-2 border-b border-border/50 bg-secondary/40 px-3 py-1.5 text-xs">
            <span className="shrink-0 text-muted-foreground">附带截图</span>
            <div
              role="group"
              aria-label="批注截图方式"
              className="flex items-center gap-1 rounded-lg bg-secondary/80 p-0.5"
            >
              {(['element', 'viewport', 'none'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={screenshotMode === option}
                  className={cn(
                    'cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
                    screenshotMode === option
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => {
                    setScreenshotPickerOpen(false)
                    void runAction({ type: 'include', screenshot: option })
                  }}
                >
                  {screenshotLabels[option]}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="px-3 pt-2.5 pb-1.5">
          <textarea
            ref={commentRef}
            aria-label="批注说明"
            value={comment}
            autoFocus
            rows={2}
            maxLength={16000}
            placeholder={state.editing ? '编辑批注说明…' : '补充说明（选填），或直接保存标记…'}
            className="min-h-12 w-full resize-none overflow-y-auto bg-transparent text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground"
            onChange={(event) => {
              setComment(event.target.value)
              void platform
                .action({ type: 'comment', text: event.target.value })
                .catch((cause) => setError(String(cause)))
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                if (screenshotPickerOpen) setScreenshotPickerOpen(false)
                else void runAction({ type: 'cancel' })
              } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void runAction({ type: 'add' })
              }
            }}
          />
        </div>

        {state.expanded && annotation?.kind === 'element' ? (
          <div className="max-h-48 overflow-y-auto border-t border-border/60 bg-secondary/30 px-3 py-2 text-xs">
            {Object.entries(propertyNames).map(([key, label]) => {
              const value = properties[key] || ''
              return (
                <div
                  key={key}
                  className="flex items-center justify-between gap-2 border-b border-border/35 py-1 last:border-0"
                >
                  <span className="shrink-0 text-muted-foreground">{label}</span>
                  <button
                    type="button"
                    disabled={!value}
                    onClick={() => copyProperty(key, value)}
                    className="flex max-w-[58%] cursor-pointer items-center gap-1.5 truncate rounded-md border border-border/60 bg-card/70 px-1.5 py-0.5 font-mono text-[11px] text-foreground transition-colors hover:border-border disabled:cursor-default disabled:opacity-60"
                  >
                    {colorProperties.has(key) && value ? (
                      <span
                        className="size-2.5 shrink-0 rounded-full border border-border/80"
                        style={{ backgroundColor: value }}
                      />
                    ) : null}
                    <span className="truncate">{copiedKey === key ? '已复制' : value || '—'}</span>
                  </button>
                </div>
              )
            })}
          </div>
        ) : null}

        {activeError ? (
          <p role="alert" className="border-t border-border/40 px-3 py-1.5 text-xs text-destructive">
            {activeError}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-2 border-t border-border/50 px-3 py-2">
          {state.editing ? (
            <Button
              size="xs"
              variant="ghost"
              className="h-7 gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:text-destructive"
              disabled={pending}
              onClick={() => void runAction({ type: 'remove' })}
            >
              <Trash2 className="size-3.5" />
              <span>删除</span>
            </Button>
          ) : (
            <span className="text-[11px] text-muted-foreground">⌘↵ 保存 · Esc 取消</span>
          )}
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              className="h-7 rounded-lg px-2.5 text-xs"
              disabled={pending}
              onClick={() => void runAction({ type: 'cancel' })}
            >
              取消
            </Button>
            <Button
              size="xs"
              variant={state.editing || hasComment ? 'default' : 'ghost'}
              className={cn(
                'h-7 gap-1 rounded-lg px-2.5 text-xs',
                !state.editing && !hasComment && 'bg-primary/15 text-primary hover:bg-primary/25',
              )}
              disabled={pending}
              onClick={() => void runAction({ type: 'add' })}
            >
              <Check className="size-3.5" />
              <span>{saveLabel}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ToolbarListItem({
  item,
  disabled,
  onFocus,
  onRemove,
}: {
  item: BrowserOverlayAnnotationItem
  disabled: boolean
  onFocus?: () => void
  onRemove: () => void
}) {
  const target = annotationTargetLabel(item)
  const size = `${Math.round(item.rect.width)}×${Math.round(item.rect.height)}`
  const emptyText = annotationEmptyComment(item)
  const commentText = item.comment.trim()

  return (
    <div className="group flex items-start gap-2 px-3 py-2 hover:bg-secondary/45">
      <button
        type="button"
        disabled={disabled || !onFocus}
        onClick={onFocus}
        className={cn('min-w-0 flex-1 text-left', onFocus ? 'cursor-pointer' : 'cursor-default')}
      >
        <div className="flex items-center gap-1.5">
          <span className="inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-primary/15 px-1 text-[11px] font-semibold tabular-nums text-primary">
            {item.markerNumber}
          </span>
          <span className="truncate font-mono text-[11px] text-foreground">{target}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{size}</span>
          {item.hasImage ? <Camera className="size-3 shrink-0 text-muted-foreground" /> : null}
        </div>
        <p
          className={cn(
            'mt-1 line-clamp-2 text-xs leading-4',
            commentText ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {commentText || emptyText}
        </p>
        {!item.isCurrentPage ? (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{annotationSourceLabel(item)}</p>
        ) : null}
      </button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`删除第 ${item.markerNumber} 条批注`}
        disabled={disabled}
        className="size-6 shrink-0 rounded-md text-muted-foreground opacity-70 hover:text-destructive hover:opacity-100"
        onClick={onRemove}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  )
}
