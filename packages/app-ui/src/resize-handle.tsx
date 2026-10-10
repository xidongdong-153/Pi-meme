import type { PointerEvent as ReactPointerEvent } from 'react'
import { useRef } from 'react'

/** 侧栏宽度拖拽句柄：按下后监听 window 指针事件，拖拽期间禁用文本选择并保持 col-resize 光标。 */
export function ResizeHandle({
  side,
  width,
  min,
  max,
  onResize,
  onDraggingChange,
}: {
  side: 'left' | 'right'
  width: number
  min: number
  max: number
  onResize: (width: number) => void
  onDraggingChange?: (dragging: boolean) => void
}) {
  const start = useRef<{ x: number; width: number } | null>(null)

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    start.current = { x: event.clientX, width }
    onDraggingChange?.(true)
    document.documentElement.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMove = (moveEvent: PointerEvent) => {
      const from = start.current
      if (!from) return
      const delta = moveEvent.clientX - from.x
      const next = side === 'left' ? from.width + delta : from.width - delta
      onResize(Math.round(Math.min(max, Math.max(min, next))))
    }
    const handleEnd = () => {
      if (!start.current) return
      start.current = null
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
      onDraggingChange?.(false)
      document.documentElement.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? '调整侧边栏宽度' : '调整右侧栏宽度'}
      title="拖拽调整宽度"
      onPointerDown={handlePointerDown}
      className="relative z-20 -mx-[2px] w-[5px] shrink-0 cursor-col-resize touch-none hover:bg-primary/30 active:bg-primary/40"
    />
  )
}
