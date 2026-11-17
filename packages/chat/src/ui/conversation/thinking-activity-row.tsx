import * as React from 'react'
import type { ActivityItem } from '../model/types'
import { cn } from '@pi-meme/ui/lib/utils'
import { ChevronDown, Sparkles } from 'lucide-react'
import { getThinkingLabel } from '../model/thinking-labels'
import { RetainedDisclosure } from './retained-disclosure'

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
  const isRunning = isLive && item.status === 'running'
  const isWorking = isRunning && !isPaused
  const detailsId = React.useId()

  return (
    <div className="conversation-event min-w-0 select-none">
      <button
        type="button"
        aria-label="思考过程"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={onToggle}
        className={cn(
          'conversation-activity-toggle group/thinking-toggle flex min-h-6 w-fit max-w-full items-start gap-2 pr-1 rounded cursor-pointer text-left transition-colors',
          'text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <span aria-hidden="true" className="mt-[0.16em] inline-flex size-[1.4em] shrink-0 items-center justify-center">
          <Sparkles
            className={cn(
              'size-[1.15em] transition-colors',
              isWorking
                ? 'text-primary animate-[thought-pulse_1.6s_ease-in-out_infinite] motion-reduce:animate-none'
                : 'text-muted-foreground group-hover/thinking-toggle:text-foreground',
            )}
          />
        </span>
        <span className={cn('min-w-0 truncate', isWorking && 'thought-shimmer')}>{label}</span>
        <span
          aria-hidden="true"
          className={cn(
            'mt-[0.16em] inline-flex size-[1.4em] shrink-0 items-center justify-center text-muted-foreground/70 transition-[rotate] duration-200 ease-out motion-reduce:transition-none',
            !open && '-rotate-90',
          )}
        >
          <ChevronDown className="size-3.5" />
        </span>
      </button>

      <RetainedDisclosure
        open={open}
        id={detailsId}
        aria-hidden={!open}
        inert={!open}
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-[240ms] ease-out motion-reduce:transition-none',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="max-h-[min(20rem,50vh)] overflow-auto overscroll-contain">
            <div className="mt-1 pb-1 select-text">
              <div className="py-0.5">
                <pre className="pi-content whitespace-pre-wrap text-xs leading-[var(--conversation-line-height,1.72)] text-muted-foreground/75">
                  {item.thinking.trimEnd() || '正在梳理思路…'}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </RetainedDisclosure>
    </div>
  )
}
