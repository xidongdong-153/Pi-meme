import * as React from 'react'
import type { ActivityItem } from '../model/types'
import { cn } from '@pi-meme/ui/lib/utils'
import { ChevronDown, Sparkles } from 'lucide-react'
import { getThinkingLabel } from '../model/thinking-labels'

export function ThinkingActivityRow({
  item,
  open,
  onToggle,
  isPaused = false,
  isLive = false,
}: {
  item: Extract<ActivityItem, { type: 'thinking' }>
  open: boolean
  onToggle: () => void
  isPaused?: boolean
  isLive?: boolean
}) {
  const label = React.useMemo(() => getThinkingLabel(item.id || item.thinking), [item.id, item.thinking])
  const isWorking = (item.status === 'running' || (isLive && item.status !== 'success')) && !isPaused

  const [elapsed, setElapsed] = React.useState<number | null>(null)
  const startTimeRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    if (isWorking) {
      const started = startTimeRef.current ?? performance.now()
      startTimeRef.current = started
      const timer = window.setInterval(() => {
        setElapsed((performance.now() - started) / 1000)
      }, 100)
      return () => window.clearInterval(timer)
    }

    if (startTimeRef.current !== null) {
      setElapsed((performance.now() - startTimeRef.current) / 1000)
      startTimeRef.current = null
    }
  }, [isWorking])

  const formattedTime = React.useMemo(() => {
    if (elapsed === null) return null
    return `${elapsed.toFixed(1)}s`
  }, [elapsed])

  return (
    <div className="text-xs select-none">
      <div
        role="button"
        aria-label="思考过程"
        aria-expanded={open}
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        className={cn(
          'group/thinking-toggle flex min-h-6 w-fit max-w-full items-center gap-2 py-0.5 pr-1 rounded leading-5 cursor-pointer transition-colors',
          'text-muted-foreground hover:text-foreground',
        )}
      >
        {!isPaused && (
          <Sparkles
            className={cn(
              'size-4 shrink-0 transition-all duration-300',
              isWorking
                ? 'text-primary animate-[thought-pulse_1.6s_ease-in-out_infinite]'
                : 'text-muted-foreground group-hover/thinking-toggle:text-foreground',
            )}
          />
        )}
        <span className="relative inline-grid items-center min-w-0">
          <span
            aria-hidden={!isWorking}
            className={cn(
              'col-start-1 row-start-1 truncate transition-[filter,opacity] duration-300 ease-out',
              isWorking ? 'opacity-100 filter-none' : 'opacity-0 blur-[2px] pointer-events-none select-none',
            )}
          >
            <span className="thought-shimmer">{label}</span>
          </span>
          <span
            aria-hidden={isWorking}
            className={cn(
              'col-start-1 row-start-1 truncate transition-[filter,opacity] duration-300 ease-out',
              !isWorking ? 'opacity-100 filter-none' : 'opacity-0 blur-[2px] pointer-events-none select-none',
            )}
          >
            <span>{label}</span>
          </span>
        </span>
        {formattedTime !== null && (
          <span
            aria-label={`思考用时 ${formattedTime}`}
            className={cn(
              'shrink-0 text-xs tabular-nums font-mono transition-opacity duration-300',
              isWorking ? 'text-primary/90 font-medium' : 'text-muted-foreground/60',
            )}
          >
            {formattedTime}
          </span>
        )}
        <span
          aria-hidden="true"
          className={cn(
            'inline-flex size-3.5 shrink-0 text-muted-foreground/70 opacity-0 transition-[opacity,transform] duration-200 ease-out ml-0.5 group-hover/thinking-toggle:opacity-100 group-focus-visible/thinking-toggle:opacity-100',
            open ? 'rotate-0' : '-rotate-90',
          )}
        >
          <ChevronDown className="size-3.5" />
        </span>
      </div>

      <div
        aria-hidden={!open}
        inert={!open}
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-300 ease-out',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="min-h-0 max-h-[min(20rem,50vh)] overflow-auto overscroll-contain">
          <div className="mt-1 pb-1 select-text">
            <div className="py-0.5">
              <pre className="pi-content whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground/75">
                {item.thinking.trimEnd() || '正在梳理思路…'}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
