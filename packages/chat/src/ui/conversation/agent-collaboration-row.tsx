import { Clock3, MessageCircle, Send } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'
import type { AgentCollaborationStatus } from '../model/types'

export function AgentCollaborationRow({ item }: { item: AgentCollaborationStatus }) {
  const active = item.status === 'running'
  const Icon = item.kind === 'feedback' ? Send : item.status === 'success' ? MessageCircle : Clock3
  return (
    <p
      role="status"
      aria-label="协作状态"
      className={cn(
        'flex min-w-0 items-start gap-2 py-2 text-sm leading-5 text-muted-foreground',
        active && 'text-foreground',
        item.status === 'error' && 'text-destructive',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 inline-flex size-3.5 shrink-0',
          active &&
            item.kind === 'wait' &&
            'animate-[thought-pulse_1.8s_ease-in-out_infinite] motion-reduce:animate-none',
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{item.text}</span>
    </p>
  )
}
