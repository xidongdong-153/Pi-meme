import * as React from 'react'
import type { ActivityItem } from '../model/types'
import { cn } from '@pi-meme/ui/lib/utils'
import { ChevronDown, Loader2, Sparkles } from 'lucide-react'
import { getThinkingLabel } from '../model/thinking-labels'

export function ThinkingActivityRow({
  item,
  open,
  onToggle,
  isNested = true,
}: {
  item: Extract<ActivityItem, { type: 'thinking' }>
  open: boolean
  onToggle: () => void
  isNested?: boolean
}) {
  const isRunning = item.status === 'running'
  const label = React.useMemo(() => getThinkingLabel(item.id || item.thinking), [item.id, item.thinking])

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
          'group inline-flex max-w-full items-center gap-1.5 py-1 px-1.5 -mx-1 rounded cursor-pointer transition-colors',
          'text-muted-foreground hover:text-foreground hover:bg-secondary/30',
          isNested && 'pl-2',
        )}
      >
        {isRunning ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <Sparkles className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
        )}
        <span className="truncate font-mono text-[0.75rem]">{label}</span>
        <ChevronDown
          className={cn(
            'size-3 shrink-0 text-muted-foreground/70 transition-transform duration-200 ml-0.5',
            open ? 'rotate-0' : '-rotate-90',
          )}
        />
      </div>

      {open && (
        <div className={cn('my-1 select-text', isNested ? 'pl-6' : 'pl-4')}>
          <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap font-mono text-[0.6875rem] leading-relaxed text-muted-foreground/75">
            {item.thinking || '正在梳理思路…'}
          </pre>
        </div>
      )}
    </div>
  )
}
