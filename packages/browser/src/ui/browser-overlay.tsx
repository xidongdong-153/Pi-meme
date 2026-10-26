import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserOverlayAction, BrowserOverlayPlatform, BrowserOverlayState } from '@pi-meme/contracts/browser'
import { Button } from '@pi-meme/ui/components/ui/button'
import {
  ArrowUp,
  Camera,
  Check,
  EyeOff,
  GripVertical,
  Mic,
  MoreHorizontal,
  Scan,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'

const propertyNames: Record<string, string> = {
  color: '文本颜色',
  'background-color': '背景',
  opacity: '透明度',
  'font-family': '字体',
  'font-size': '字号',
  'font-weight': '字重',
  'border-radius': '边框圆角半径',
  'border-color': '边框颜色',
  'border-width': '边框宽度',
  padding: '内边距',
}

export function BrowserOverlay({ platform }: { platform: BrowserOverlayPlatform }) {
  const [state, setState] = useState<BrowserOverlayState>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [compact, setCompact] = useState(false)
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false)
  const [comment, setComment] = useState('')
  const [multiline, setMultiline] = useState(false)
  const commentRef = useRef<HTMLTextAreaElement>(null)
  const requestedEditorHeight = useRef(0)
  const drag = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null)
  const dragFrame = useRef(0)
  useEffect(() => {
    const release = platform.onState(setState)
    void platform
      .state()
      .then(setState)
      .catch((cause) => setError(String(cause)))
    return () => {
      release()
      cancelAnimationFrame(dragFrame.current)
    }
  }, [platform])
  useEffect(() => {
    const measure = () => setCompact(window.innerWidth < 370)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
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
    const restore = () => void platform.action({ type: 'original', pressed: false }).catch(() => {})
    window.addEventListener('blur', restore)
    return () => window.removeEventListener('blur', restore)
  }, [platform, state?.kind])
  useLayoutEffect(() => {
    requestedEditorHeight.current = 0
    setComment(state?.annotation?.comment ?? '')
  }, [state?.annotation?.id])
  useLayoutEffect(() => {
    if (state?.kind !== 'editor') return
    const input = commentRef.current
    if (!input) return
    const measure = () => {
      input.style.height = '0px'
      let wraps = false
      if (!state.expanded) {
        input.style.width = 'calc(100% - 5rem)'
        wraps = input.scrollHeight > 50
        input.style.width = wraps ? '100%' : 'calc(100% - 5rem)'
      } else input.style.width = ''
      const textHeight = Math.max(40, input.scrollHeight)
      input.style.height = `${textHeight}px`
      setMultiline(wraps)
      const height = state.expanded ? Math.max(356, textHeight + 180) : wraps ? textHeight + 56 : 64
      if (requestedEditorHeight.current === height) return
      requestedEditorHeight.current = height
      void platform.action({ type: 'resize-editor', height }).catch((cause) => setError(String(cause)))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [comment, platform, state?.annotation?.id, state?.expanded, state?.kind])
  const action = async (value: BrowserOverlayAction) => {
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
  if (!state) return <p role="status">{error || '正在加载批注…'}</p>
  if (state.kind === 'toolbar')
    return (
      <div
        className={`flex h-full justify-center bg-transparent px-1 text-foreground ${toolbarMenuOpen ? 'items-end pb-1' : 'items-center'}`}
      >
        <div className="flex h-10 max-w-full items-center gap-1 rounded-xl border border-border/60 bg-card px-1.5 shadow-xl">
          <button
            type="button"
            aria-label="拖动批注工具条"
            className="flex h-8 w-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
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
            <GripVertical className="size-4" />
          </button>
          <span className="min-w-0 truncate px-1 text-xs font-medium">
            正在批注{state.count ? ` · ${state.count}` : ''}
          </span>
          {!compact ? (
            <Button
              size="icon-sm"
              className="size-7 shrink-0"
              variant="ghost"
              title="截取当前页面"
              aria-label="截取当前页面"
              onClick={() => void action({ type: 'screenshot' })}
            >
              <Scan className="size-4" />
            </Button>
          ) : null}
          <Button
            size="icon-sm"
            className="size-7 shrink-0"
            variant="ghost"
            title="隐藏标记"
            aria-label="隐藏标记"
            aria-pressed={state.hidden}
            onClick={() => void action({ type: 'hide', hidden: !state.hidden })}
          >
            <EyeOff className={`size-4 ${state.hidden ? 'text-primary' : ''}`} />
          </Button>
          {!compact ? (
            <Button
              size="icon-sm"
              className="size-7 shrink-0"
              variant="ghost"
              title="按住查看原始页面"
              aria-label="按住查看原始页面"
              onPointerDown={() => void platform.action({ type: 'original', pressed: true })}
              onPointerUp={() => void platform.action({ type: 'original', pressed: false })}
              onPointerCancel={() => void platform.action({ type: 'original', pressed: false })}
              onPointerLeave={() => void platform.action({ type: 'original', pressed: false })}
            >
              <Camera className="size-4" />
            </Button>
          ) : null}
          {!compact ? (
            <Button
              size="icon-sm"
              className="size-7 shrink-0"
              variant="ghost"
              title="丢弃批注"
              aria-label="丢弃批注"
              disabled={!state.count && !state.annotation}
              onClick={() => void action({ type: 'discard' })}
            >
              <Trash2 className="size-4" />
            </Button>
          ) : null}
          {compact ? (
            <DropdownMenu
              open={toolbarMenuOpen}
              onOpenChange={(open) => {
                setToolbarMenuOpen(open)
                void platform.action({ type: 'toolbar-menu', open })
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" className="size-7 shrink-0" aria-label="更多批注操作">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end">
                <DropdownMenuItem onSelect={() => void action({ type: 'screenshot' })}>截取当前页面</DropdownMenuItem>
                <DropdownMenuItem
                  onPointerDown={() => void platform.action({ type: 'original', pressed: true })}
                  onPointerUp={() => void platform.action({ type: 'original', pressed: false })}
                  onPointerCancel={() => void platform.action({ type: 'original', pressed: false })}
                >
                  按住查看原始页面
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!state.count && !state.annotation}
                  onSelect={() => void action({ type: 'discard' })}
                >
                  丢弃批注
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Button
            size="sm"
            className="h-7 shrink-0 rounded-lg px-2 text-xs"
            disabled={pending || (!state.count && !state.annotation)}
            onClick={() => void action({ type: 'submit' })}
          >
            发送
          </Button>
          <Button
            size="icon-sm"
            className="size-7 shrink-0"
            variant="ghost"
            title="退出批注"
            aria-label="退出批注"
            onClick={() => void action({ type: 'exit' })}
          >
            <X className="size-4" />
          </Button>
        </div>
        {error ? (
          <p role="alert" className="absolute bottom-0 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    )

  const annotation = state.annotation
  const properties = annotation?.kind === 'element' ? (annotation.styles ?? {}) : {}
  const commentInput = (className: string) => (
    <textarea
      ref={commentRef}
      aria-label="批注评论"
      value={comment}
      autoFocus
      rows={1}
      maxLength={16000}
      placeholder={state.expanded ? '描述这些更改…' : '添加评论…'}
      className={className}
      onChange={(event) => {
        setComment(event.target.value)
        void platform.action({ type: 'comment', text: event.target.value }).catch((cause) => setError(String(cause)))
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          void action({ type: 'cancel' })
        } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault()
          void action({ type: 'add' })
        }
      }}
    />
  )
  const saveButton = (expanded = false) => (
    <Button
      size="icon-sm"
      className={`${expanded ? 'size-8' : 'size-9'} shrink-0 rounded-full disabled:opacity-100 ${expanded || state.editing ? 'bg-foreground text-background hover:bg-foreground/90' : comment.trim() ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-muted-foreground/60 text-background'}`}
      disabled={pending || !comment.trim()}
      title={state.editing ? '保存批注' : '加入对话'}
      aria-label={state.editing ? '保存批注' : '加入对话'}
      onClick={() => void action({ type: 'add' })}
    >
      {state.editing && !expanded ? <Check className="size-4" /> : <ArrowUp className="size-4" />}
    </Button>
  )
  if (!state.expanded)
    return (
      <div
        className={`group relative m-1 flex h-[calc(100%-8px)] gap-3 rounded-[28px] border border-border/60 bg-secondary px-3 text-foreground shadow-xl ${multiline ? 'items-start' : 'items-center'}`}
      >
        <Button
          size="icon-sm"
          variant="ghost"
          className={`absolute left-2 size-8 rounded-full transition-opacity focus-visible:opacity-100 ${multiline ? 'top-2 opacity-100' : 'top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100'}`}
          title="查看元素属性"
          aria-label="查看元素属性"
          aria-expanded={false}
          onClick={() => void action({ type: 'expand', expanded: true })}
        >
          <SlidersHorizontal className="size-4" />
        </Button>
        {commentInput(
          'min-h-10 w-full min-w-0 resize-none overflow-hidden bg-transparent py-2.5 pl-9 text-sm leading-6 outline-none placeholder:text-muted-foreground',
        )}
        <div
          className={`absolute right-3 flex items-center gap-3 ${multiline ? 'bottom-3' : 'top-1/2 -translate-y-1/2'}`}
        >
          <Mic className="size-4 shrink-0" aria-hidden="true" />
          {saveButton()}
        </div>
        {error ? (
          <p role="alert" className="absolute -bottom-5 left-3 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    )
  return (
    <div className="m-1 flex h-[calc(100%-8px)] flex-col overflow-hidden rounded-[22px] border border-border/70 bg-secondary text-foreground shadow-xl">
      <div className="flex min-h-12 items-start gap-2 px-3 py-2">
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-7 shrink-0 rounded-full bg-secondary/70"
          title="查看元素属性"
          aria-label="查看元素属性"
          aria-expanded={state.expanded}
          onClick={() => void action({ type: 'expand', expanded: !state.expanded })}
        >
          <SlidersHorizontal className="size-4" />
        </Button>
        {commentInput(
          'min-h-8 min-w-0 flex-1 resize-none overflow-hidden bg-transparent py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground',
        )}
        {state.editing ? (
          <Button
            size="icon-sm"
            variant="ghost"
            title="删除批注"
            aria-label="删除批注"
            onClick={() => void action({ type: 'remove' })}
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-y border-border/70 text-xs">
        <div className="bg-secondary/65 px-4 py-2 text-muted-foreground">&lt;{annotation?.tag || '区域'}&gt;</div>
        <div className="px-4 py-2">
          {Object.entries(propertyNames).map(([key, label]) => (
            <div
              key={key}
              className="flex items-center justify-between gap-3 border-b border-border/40 py-1 last:border-0"
            >
              <span>{label}</span>
              <span
                className="w-[48%] truncate rounded-lg border border-border bg-card/60 px-2 py-1 font-mono text-muted-foreground"
                title={properties[key]}
              >
                {properties[key] || '—'}
              </span>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 py-1.5">
            <span>宽度 × 高度</span>
            <span className="font-mono text-muted-foreground">
              {Math.round(annotation?.rect.width ?? 0)} × {Math.round(annotation?.rect.height ?? 0)} px
            </span>
          </div>
          <label className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
            <span>批注截图</span>
            <select
              aria-label="批注截图"
              className="rounded-md bg-secondary px-2 py-1"
              value={state.screenshot}
              onChange={(event) =>
                void action({ type: 'include', screenshot: event.target.value as BrowserOverlayState['screenshot'] })
              }
            >
              <option value="element">元素截图</option>
              <option value="viewport">当前视口</option>
              <option value="none">不附截图</option>
            </select>
          </label>
        </div>
      </div>
      <div className="flex min-h-11 items-center justify-between gap-2 border-t border-border/50 px-3 pb-1">
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-full"
          onClick={() => void action({ type: 'cancel' })}
        >
          取消
        </Button>
        <div className="flex items-center gap-3">
          <Mic className="size-4" aria-hidden="true" />
          {saveButton(true)}
        </div>
      </div>
      {error ? (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
