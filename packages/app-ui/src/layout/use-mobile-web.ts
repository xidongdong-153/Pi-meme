import { useEffect, useRef, useState } from 'react'

const MOBILE_MEDIA_QUERY = '(max-width: 767px)'

function matchesMobileViewport() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches
}

/** 仅独立 Web 按视口进入移动端模式；Electron Desktop（nativeWindow）恒为 false。 */
export function useMobileWeb(nativeWindow: boolean): boolean {
  const [narrow, setNarrow] = useState(() => !nativeWindow && matchesMobileViewport())

  useEffect(() => {
    if (nativeWindow || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      setNarrow(false)
      return
    }
    const media = window.matchMedia(MOBILE_MEDIA_QUERY)
    const sync = () => setNarrow(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [nativeWindow])

  return !nativeWindow && narrow
}

/** 跟随移动端软键盘可视区域高度，防止 iOS Safari 顶栏被顶出视口或底栏被遮挡。 */
export function useVisualViewportHeight(enabled: boolean): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined)

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      setHeight(undefined)
      return
    }
    const viewport = window.visualViewport
    if (!viewport) return

    let frame = 0
    const sync = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const next = Math.round(viewport.height)
        if (next > 0) setHeight(next)
        if (window.scrollY !== 0) window.scrollTo(0, 0)
      })
    }

    sync()
    viewport.addEventListener('resize', sync)
    viewport.addEventListener('scroll', sync)
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', sync)
      viewport.removeEventListener('scroll', sync)
    }
  }, [enabled])

  return height
}

/** 同步浏览器状态栏 theme-color 与当前页面背景色。 */
export function useSyncThemeColor(enabled: boolean, dependency: unknown) {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return
    const frame = requestAnimationFrame(() => {
      const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      if (!meta) return
      const bg = getComputedStyle(document.body).backgroundColor
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        meta.content = bg
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [enabled, dependency])
}

/** 锁屏/切后台返回前台或网络恢复时自动静默刷新连接与状态。 */
export function useMobileForegroundSync(enabled: boolean, onResume?: () => void) {
  const onResumeRef = useRef(onResume)
  onResumeRef.current = onResume

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof document === 'undefined') return
    let hiddenAt = 0
    let lastTrigger = 0

    const trigger = (force = false) => {
      const now = Date.now()
      if (!force && now - lastTrigger < 1500) return
      lastTrigger = now
      onResumeRef.current?.()
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
      } else if (document.visibilityState === 'visible') {
        if (hiddenAt > 0 && Date.now() - hiddenAt >= 2000) trigger()
        hiddenAt = 0
      }
    }

    const onOnline = () => trigger(true)

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
    }
  }, [enabled])
}

export type MobileBackLayer = {
  active: boolean
  onBack: () => void
}

const MOBILE_BACK_SENTINEL = '__piMemeMobileBack'

function hasMobileBackSentinel(): boolean {
  if (typeof window === 'undefined') return false
  const state = window.history.state as Record<string, unknown> | null
  return Boolean(state && state[MOBILE_BACK_SENTINEL] === true)
}

/** 接管移动端浏览器返回键 / 边缘侧滑返回，按优先级依次关闭 Sheet → 抽屉 → 子页/设置。 */
export function useMobileBackNavigation(enabled: boolean, layers: readonly MobileBackLayer[]) {
  const layersRef = useRef(layers)
  layersRef.current = layers
  const ignorePopRef = useRef(false)
  const hasActiveLayer = enabled && layers.some((layer) => layer.active)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (hasActiveLayer) {
      if (!hasMobileBackSentinel()) {
        try {
          window.history.pushState({ ...(window.history.state ?? {}), [MOBILE_BACK_SENTINEL]: true }, '')
        } catch {
          // 某些受限上下文不允许 pushState 时静默降级
        }
      }
    } else if (hasMobileBackSentinel()) {
      ignorePopRef.current = true
      window.history.back()
    }
  }, [hasActiveLayer])

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const onPopState = () => {
      if (ignorePopRef.current) {
        ignorePopRef.current = false
        return
      }
      const activeLayers = layersRef.current.filter((layer) => layer.active)
      if (activeLayers.length === 0) return
      activeLayers[0]!.onBack()
      if (activeLayers.length > 1) {
        queueMicrotask(() => {
          if (!hasMobileBackSentinel()) {
            try {
              window.history.pushState({ ...(window.history.state ?? {}), [MOBILE_BACK_SENTINEL]: true }, '')
            } catch {
              // 静默忽略
            }
          }
        })
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [enabled])
}

/** 移动端边缘右滑呼出抽屉、左滑关闭抽屉，自动避开横向滚动区与滑块。 */
export function useMobileDrawerSwipe({
  enabled,
  open,
  onOpen,
  onClose,
}: {
  enabled: boolean
  open: boolean
  onOpen: () => void
  onClose: () => void
}) {
  const stateRef = useRef({ open, onOpen, onClose })
  stateRef.current = { open, onOpen, onClose }

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    let tracking: { mode: 'open' | 'close'; startX: number; startY: number } | null = null

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return
      const touch = event.touches[0]!
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('[role="slider"], input, textarea')) return

      if (!stateRef.current.open) {
        if (touch.clientX > 26) return
        if (target?.closest('pre, table, .no-scrollbar, [role="dialog"]')) return
        tracking = { mode: 'open', startX: touch.clientX, startY: touch.clientY }
      } else {
        tracking = { mode: 'close', startX: touch.clientX, startY: touch.clientY }
      }
    }

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking || event.touches.length !== 1) return
      const touch = event.touches[0]!
      const dx = touch.clientX - tracking.startX
      const dy = touch.clientY - tracking.startY
      if (Math.abs(dy) > Math.abs(dx) * 0.9 && Math.abs(dy) > 14) {
        tracking = null
        return
      }
      if (tracking.mode === 'open' && dx > 56 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        tracking = null
        stateRef.current.onOpen()
      } else if (tracking.mode === 'close' && dx < -56 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        tracking = null
        stateRef.current.onClose()
      }
    }

    const clear = () => {
      tracking = null
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('touchend', clear, { passive: true })
    window.addEventListener('touchcancel', clear, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', clear)
      window.removeEventListener('touchcancel', clear)
    }
  }, [enabled])
}
