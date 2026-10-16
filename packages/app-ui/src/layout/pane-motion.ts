import { useCallback, useEffect, useRef, useState } from 'react'

/** 与 `.workspace-panes` 的过渡时长一致。 */
export const paneMotionMs = 280

/** 指针越过最小值这么多像素后松手，收起侧栏，已保存的宽度不变。 */
export const paneCollapsePull = 56

const rubberUnder = 0.62
const rubberOver = 0.34

export type PaneSettle = { collapse: boolean; width: number }

/** 区间内跟手；越界后按阻尼缩短位移，用来做出边界被拉开的感觉。 */
export function resistWidth(value: number, min: number, max: number) {
  if (!(max > min)) return min
  if (value < min) return min - (min - value) * rubberUnder
  if (value > max) return max + (value - max) * rubberOver
  return value
}

/** 松手：拉过收起阈值则关闭，否则夹回允许区间。 */
export function settlePane(value: number, min: number, max: number): PaneSettle {
  if (value <= min - paneCollapsePull) return { collapse: true, width: min }
  const ceiling = Math.max(min, max)
  return { collapse: false, width: Math.round(Math.min(ceiling, Math.max(min, value))) }
}

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return reduced
}

/**
 * 把开合和拖拽收成一个宽度，写到父级 CSS 变量上。
 * 过渡由变量插值完成，这里不逐帧 setState。
 * 松手回弹要先关掉拖拽、再在下一帧改目标，否则过渡还没启用，宽度会直接跳过去。
 */
export function usePaneMotion(open: boolean, width: number, reduced: boolean) {
  const [presented, setPresented] = useState(open ? width : 0)
  const [dragging, setDragging] = useState(false)
  const [overscroll, setOverscroll] = useState(false)
  const [instant, setInstant] = useState(false)
  const [mounted, setMounted] = useState(open)
  const [springTo, setSpringTo] = useState<number | null>(null)
  const draggingRef = useRef(false)
  const springRef = useRef(false)
  const openRef = useRef(open)
  const widthRef = useRef(width)
  const reducedRef = useRef(reduced)
  openRef.current = open
  widthRef.current = width
  reducedRef.current = reduced

  if (open && !mounted) setMounted(true)

  useEffect(() => {
    if (draggingRef.current || springRef.current) return
    if (!open) {
      setPresented(0)
      setOverscroll(false)
      if (reduced) setMounted(false)
      return
    }
    setMounted(true)
    setPresented((current) => (current === width ? current : width))
  }, [open, width, reduced])

  useEffect(() => {
    if (springTo === null) return
    springRef.current = false
    setPresented(springTo)
    setSpringTo(null)
  }, [springTo])

  useEffect(() => {
    if (open || presented !== 0 || dragging) return
    if (reduced) {
      setMounted(false)
      return
    }
    const timeout = window.setTimeout(() => {
      if (!openRef.current && !draggingRef.current) setMounted(false)
    }, paneMotionMs + 40)
    return () => window.clearTimeout(timeout)
  }, [open, presented, dragging, reduced])

  useEffect(() => {
    if (!instant) return
    const frame = requestAnimationFrame(() => setInstant(false))
    return () => cancelAnimationFrame(frame)
  }, [instant])

  const beginDrag = useCallback((visual: number) => {
    springRef.current = false
    setSpringTo(null)
    draggingRef.current = true
    setDragging(true)
    setMounted(true)
    setPresented(Math.round(visual))
  }, [])

  const dragTo = useCallback((visual: number, collapsing: boolean) => {
    setPresented(Math.round(visual))
    setOverscroll(collapsing)
  }, [])

  const endDrag = useCallback((result: PaneSettle) => {
    draggingRef.current = false
    setDragging(false)
    setOverscroll(false)
    const target = result.collapse ? 0 : result.width
    if (reducedRef.current) {
      springRef.current = false
      setPresented(target)
      if (result.collapse) setMounted(false)
      return
    }
    springRef.current = true
    setSpringTo(target)
  }, [])

  const jump = useCallback(() => {
    if (draggingRef.current) return
    springRef.current = false
    setSpringTo(null)
    setInstant(true)
    setPresented(openRef.current ? widthRef.current : 0)
    if (!openRef.current) setMounted(false)
  }, [])

  return { presented, dragging, overscroll, instant, mounted, beginDrag, dragTo, endDrag, jump }
}
