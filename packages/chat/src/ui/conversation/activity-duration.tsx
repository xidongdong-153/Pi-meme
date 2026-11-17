import * as React from 'react'
import { cn } from '@pi-meme/ui/lib/utils'
import { usePresentationActive } from './retained-disclosure'

function formatActivityDuration(durationMs: number): string {
  const tenths = Math.round(durationMs / 100)
  const seconds = ((tenths % 600) / 10).toFixed(1)
  const minutes = Math.floor(tenths / 600) % 60
  const hours = Math.floor(tenths / 36000)
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${seconds.padStart(4, '0')}s`
  if (minutes > 0) return `${minutes}m ${seconds.padStart(4, '0')}s`
  return `${seconds}s`
}

export const ActivityDuration = React.memo(ActivityDurationContent)

function ActivityDurationContent({
  startedAt,
  durationMs,
  isRunning,
  isPaused = false,
  label = '工具用时',
}: {
  startedAt?: number
  durationMs?: number
  isRunning: boolean
  isPaused?: boolean
  label?: string
}) {
  const active = usePresentationActive()
  const [now, setNow] = React.useState(Date.now)
  const hasStart = startedAt !== undefined && Number.isFinite(startedAt)
  const hasDuration = durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0
  const ticking = active && isRunning && !isPaused && hasStart && !hasDuration

  React.useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [ticking, startedAt])

  const elapsedMs = hasDuration
    ? durationMs
    : isRunning && hasStart
      ? Math.max(0, (ticking ? Math.max(now, Date.now()) : now) - startedAt)
      : undefined
  if (elapsedMs === undefined) return null
  const time = formatActivityDuration(elapsedMs)

  return (
    <span
      aria-label={`${label} ${time}`}
      className={cn(
        'shrink-0 font-mono tabular-nums',
        isRunning && !isPaused ? 'text-primary font-medium' : 'text-muted-foreground',
      )}
    >
      {time}
    </span>
  )
}
