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
  isNested = true,
}: {
  item: Extract<ActivityItem, { type: 'thinking' }>
  open: boolean
  onToggle: () => void
  isPaused?: boolean
  isNested?: boolean
}) {
  const label = React.useMemo(() => getThinkingLabel(item.id || item.thinking), [item.id, item.thinking])

  return (
    <div className="text-sm select-none">
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
          'group inline-flex max-w-full items-center gap-2 py-1 px-1 rounded cursor-pointer transition-colors',
          'text-muted-foreground hover:text-foreground hover:bg-secondary/30',
          isNested && 'pl-2',
        )}
      >
        {!isPaused && <Sparkles className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />}
        <span className="truncate">{label}</span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-300 ease-out ml-0.5',
            open ? 'rotate-0' : '-rotate-90',
          )}
        />
      </div>

      <div
        aria-hidden={!open}
        inert={!open}
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-300 ease-out',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className={cn('my-1 select-text', isNested ? 'pl-6' : 'pl-4')}>
            <pre className="pi-content max-h-72 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground/75">
              {item.thinking || '正在梳理思路…'}
            </pre>
          </div>
        </div>
      </div>
    </div>
  )
}
