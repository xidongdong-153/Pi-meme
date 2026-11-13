import * as React from 'react'
import { Bot, ChevronDown } from 'lucide-react'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import { AgentAvatar } from '@pi-meme/ui/components/agent-avatar'
import { cn } from '@pi-meme/ui/lib/utils'
import { agentOperation, type AgentOperationItem } from '../model/agent-operations'
import { RetainedDisclosure } from './retained-disclosure'

export function AgentOperationRow({
  item,
  agents,
  caller,
  isLive,
  isPaused,
  onOpenAgent,
}: {
  item: AgentOperationItem
  agents: readonly AgentSummary[]
  caller?: AgentSummary
  isLive: boolean
  isPaused: boolean
  onOpenAgent?: (agentId: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const detailsId = React.useId()
  const operation = agentOperation(item, agents, caller, isLive, isPaused)
  const { recipient } = operation
  return (
    <div className="conversation-event min-w-0">
      <button
        type="button"
        aria-label={`子代理操作：${operation.summary}`}
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'conversation-activity-toggle group/agent-operation flex min-h-6 max-w-full items-start gap-2 rounded-sm pr-1 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer',
          operation.status === 'error' && 'text-destructive',
        )}
      >
        <span aria-hidden="true" className="mt-[0.16em] inline-flex size-[1.4em] shrink-0 items-center justify-center">
          <Bot className="size-[1.15em]" />
        </span>
        <span className={cn('min-w-0 [overflow-wrap:anywhere]', operation.status === 'running' && 'thought-shimmer')}>
          {operation.summary}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            'mt-[0.16em] inline-flex size-[1.4em] shrink-0 items-center justify-center text-muted-foreground/70 transition-transform duration-200 ease-out motion-reduce:transition-none',
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
          'grid transition-[grid-template-rows,opacity] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="ml-[calc(1.4em+0.5rem)] flex min-w-0 flex-col gap-2 border-l border-border py-2 pl-3 select-text">
            <div className="flex min-w-0 items-start gap-2 text-muted-foreground">
              {recipient.agentId && (
                <AgentAvatar
                  seed={recipient.agentId}
                  name={recipient.name}
                  avatar={recipient.avatar}
                  className="mt-[0.16em] size-[1.4em] shrink-0"
                />
              )}
              {recipient.agentId && onOpenAgent ? (
                <button
                  type="button"
                  className="conversation-agent-link min-w-0"
                  aria-label={`查看子代理：${recipient.name}`}
                  onClick={() => onOpenAgent(recipient.agentId!)}
                >
                  {recipient.name}
                </button>
              ) : (
                <span className="min-w-0 [overflow-wrap:anywhere]">{recipient.name}</span>
              )}
            </div>
            {operation.message && (
              <div className="max-h-80 overflow-auto whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
                {operation.message}
              </div>
            )}
            {operation.note && <p className="text-muted-foreground">{operation.note}</p>}
            {operation.error && (
              <p className="max-h-60 overflow-auto whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]">
                {operation.error}
              </p>
            )}
          </div>
        </div>
      </RetainedDisclosure>
    </div>
  )
}
