import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@pi-meme/ui/lib/utils'
import { paneCollapsePull, resistWidth, settlePane, type PaneSettle } from './pane-motion'

/** 读到过渡中的实际宽度，避免从目标宽度而不是手指所在的位置开始拖。 */
function readPaneWidth(element: HTMLElement, side: 'left' | 'right', fallback: number) {
  const host = element.closest('.workspace-panes')
  if (!host) return fallback
  const name = side === 'left' ? '--workspace-sidebar-width' : '--workspace-right-width'
  const parsed = Number.parseFloat(getComputedStyle(host).getPropertyValue(name))
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 侧栏宽度拖拽句柄。拖拽期间跟手，越界阻尼，松手后由调用方决定回弹或收起。 */
export function ResizeHandle({
  side,
  width,
  min,
  max,
  onDragStart,
  onDrag,
  onDragEnd,
}: {
  side: 'left' | 'right'
  width: number
  min: number
  max: number
  onDragStart: (visual: number) => void
  onDrag: (visual: number, collapsing: boolean) => void
  onDragEnd: (result: PaneSettle) => void
}) {
  const drag = useRef<{ x: number; width: number; raw: number } | null>(null)
  const releaseRef = useRef<(() => void) | null>(null)
  const [dragging, setDragging] = useState(false)
  const [collapsing, setCollapsing] = useState(false)
  useEffect(() => () => releaseRef.current?.(), [])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startWidth = readPaneWidth(event.currentTarget, side, width)
    drag.current = { x: event.clientX, width: startWidth, raw: startWidth }
    setDragging(true)
    setCollapsing(false)
    onDragStart(startWidth)
    document.documentElement.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMove = (moveEvent: PointerEvent) => {
      const from = drag.current
      if (!from) return
      const delta = moveEvent.clientX - from.x
      const raw = side === 'left' ? from.width + delta : from.width - delta
      from.raw = raw
      const collapsingNow = raw <= min - paneCollapsePull
      setCollapsing((current) => (current === collapsingNow ? current : collapsingNow))
      onDrag(resistWidth(raw, min, max), collapsingNow)
    }
    const handleEnd = () => {
      const from = drag.current
      if (!from) return
      drag.current = null
      releaseRef.current = null
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
      setDragging(false)
      setCollapsing(false)
      document.documentElement.style.cursor = ''
      document.body.style.userSelect = ''
      onDragEnd(settlePane(from.raw, min, max))
    }
    releaseRef.current = handleEnd
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? '调整侧边栏宽度' : '调整右侧栏宽度'}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(width)}
      title="拖拽调整宽度"
      data-dragging={dragging ? '' : undefined}
      data-collapsing={collapsing ? '' : undefined}
      onPointerDown={handlePointerDown}
      className={cn(
        'group absolute inset-y-0 z-20 w-3 touch-none cursor-col-resize',
        side === 'left' ? 'right-0 translate-x-1/2' : 'left-0 -translate-x-1/2',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/80 transition-[width,background-color,box-shadow] duration-150',
          'group-hover:w-0.5 group-hover:bg-primary/70',
          dragging && 'w-0.5 bg-primary shadow-[0_0_12px_color-mix(in_srgb,var(--primary)_45%,transparent)]',
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute top-1/2 left-1/2 h-7 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/40 opacity-0 transition-all duration-150',
          'group-hover:bg-primary group-hover:opacity-100',
          dragging && 'h-11 bg-primary opacity-100',
          collapsing && 'h-14',
        )}
      />
    </div>
  )
}
