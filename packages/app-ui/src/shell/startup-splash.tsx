import { useEffect, useRef, useState } from 'react'
import { BrandMark } from '@pi-meme/ui/components/brand-mark'
import { FadeContent } from '@pi-meme/ui/components/fade-content'
import { cn } from '@pi-meme/ui/lib/utils'

/** 快启动也要让淡入被看见；慢启动则一直留到主界面就绪。 */
export const STARTUP_SPLASH_MIN_MS = 420
export const STARTUP_SPLASH_EXIT_MS = 280

export function startupSplashSchedule(elapsedMs: number, reduceMotion: boolean) {
  if (reduceMotion) return { waitMs: 0, exitMs: 0 }
  return { waitMs: Math.max(0, STARTUP_SPLASH_MIN_MS - elapsedMs), exitMs: STARTUP_SPLASH_EXIT_MS }
}

/** 首屏遮罩。`bootComplete` 在会话快照可读、或连接失败需要把主界面交还用户时为真。 */
export function useStartupSplash(bootComplete: boolean) {
  const [phase, setPhase] = useState<'loading' | 'exiting' | 'done'>('loading')
  const startedAt = useRef(typeof performance !== 'undefined' ? performance.now() : 0)

  useEffect(() => {
    if (!bootComplete) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const { waitMs, exitMs } = startupSplashSchedule(performance.now() - startedAt.current, reduceMotion)
    let cancelled = false
    let endTimer: number | undefined
    const startTimer = window.setTimeout(() => {
      if (cancelled) return
      if (exitMs === 0) {
        setPhase('done')
        return
      }
      setPhase('exiting')
      endTimer = window.setTimeout(() => {
        if (!cancelled) setPhase('done')
      }, exitMs)
    }, waitMs)
    return () => {
      cancelled = true
      window.clearTimeout(startTimer)
      if (endTimer !== undefined) window.clearTimeout(endTimer)
    }
  }, [bootComplete])

  return phase
}

/** 进入应用后的整窗画面，直到聊天主界面可以显示。图标和名称用 FadeContent 淡入。 */
export function StartupSplash({ exiting = false }: { exiting?: boolean }) {
  return (
    <div
      className={cn('startup-splash window-drag', exiting && 'is-exiting')}
      role="status"
      aria-live="polite"
      aria-busy={!exiting}
      data-testid="startup-splash"
    >
      <FadeContent className="startup-splash-card no-drag">
        <BrandMark size={64} />
        <div className="startup-splash-name">Pi meme</div>
        <span className="sr-only">正在启动 Pi meme…</span>
      </FadeContent>
    </div>
  )
}
