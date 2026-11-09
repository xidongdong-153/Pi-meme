import { Clock3, MessageCircle, Send } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'
import type { AgentCollaborationStatus } from '../model/types'

export function AgentCollaborationRow({
  item,
  onOpenAgent,
}: {
  item: AgentCollaborationStatus
  onOpenAgent?: (agentId: string) => void
}) {
  const active = item.status === 'running'
  const Icon = item.kind === 'feedback' ? Send : item.status === 'success' ? MessageCircle : Clock3
  return (
    <p
      role="status"
      aria-label="协作状态"
      className={cn(
        'conversation-event flex min-w-0 items-start gap-2 text-muted-foreground',
        active && 'text-foreground',
        item.status === 'error' && 'text-destructive',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-[0.16em] inline-flex size-[1.4em] shrink-0 items-center justify-center',
          active &&
            item.kind === 'wait' &&
            'animate-[thought-pulse_1.8s_ease-in-out_infinite] motion-reduce:animate-none',
        )}
      >
        <Icon className="size-[1.15em]" />
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {item.textParts && onOpenAgent
          ? item.textParts.map((part, index) =>
              typeof part === 'string' ? (
                part
              ) : (
                <button
                  key={`${part.agentId}-${index}`}
                  type="button"
                  className="conversation-agent-link"
                  aria-label={`查看子代理：${part.text}`}
                  onClick={() => onOpenAgent(part.agentId)}
                >
                  {part.text}
                </button>
              ),
            )
          : item.text}
      </span>
    </p>
  )
}
