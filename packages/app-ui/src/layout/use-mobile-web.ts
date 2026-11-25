import { useEffect, useState } from 'react'

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
