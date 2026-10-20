import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import type { PiPauseInterval, PiRetryState } from '@pi-meme/contracts/pi'
import { ErrorLine } from '@pi-meme/ui/components/error-line'
import type { TurnChunk } from '../model/types'
import { AttachmentPreview } from '../content/attachment-preview'
import { MarkdownContent } from '../content/markdown-content'
import { ActivityElapsedTime, ActivityGroup } from './activity-group'
import { groupAgentActivities } from '../model/agent-collaboration'
import { AgentCollaborationRow } from './agent-collaboration-row'
import { cn } from '@pi-meme/ui/lib/utils'
import { MessageActions } from './message-actions'
import { PluginMessageActions } from '@pi-meme/ui/components/plugin-message-actions'

export function AssistantTurnView({
  turn,
  isFinalReply = !turn.isLive,
  className,
  isPaused = false,
  pauseIntervals,
  canFork,
  onFork,
  onCopyError,
  retry,
  onActivityToggle,
}: {
  turn: Extract<TurnChunk, { type: 'assistant_turn' }>
  isFinalReply?: boolean
  className?: string
  isPaused?: boolean
  pauseIntervals?: PiPauseInterval[]
  canFork?: boolean
  onFork?: (timestamp: number) => void
  onCopyError?: (message: string) => void
  retry?: PiRetryState
  onActivityToggle?: () => void
}) {
  const hasReplyContent = isFinalReply && !turn.isLive && (Boolean(turn.finalText.trim()) || turn.images.length > 0)
  const segments = React.useMemo(
    () => groupAgentActivities(turn.activities, turn.finalText, turn.collaboration),
    [turn.activities, turn.finalText, turn.collaboration],
  )
  const hasTrailingText = segments.at(-1)?.type === 'text'
  const replyIndex = !turn.isLive && turn.finalText.trim() ? segments.length - 1 : -1
  const processId = React.useId()
  const processIds = segments.flatMap((segment, index) =>
    index === replyIndex || segment.type === 'collaboration' ? [] : [`${processId}-${index}`],
  )
  const [process, setProcess] = React.useState(() => ({ isLive: turn.isLive, open: turn.isLive }))
  if (process.isLive !== turn.isLive) {
    setProcess({ isLive: turn.isLive, open: turn.isLive })
  }
  const elapsedTime = (
    <ActivityElapsedTime
      isLive={turn.isLive}
      durationMs={turn.durationMs}
      startedAt={turn.startedAt}
      isPaused={isPaused}
      pauseIntervals={pauseIntervals}
    />
  )

  return (
    <article
      data-message-role="assistant"
      className={cn('group flex w-full py-1 text-sm select-text justify-start', className)}
    >
      <div className="flex flex-col min-w-0 w-full items-start">
        <div className="text-sm text-foreground leading-relaxed bg-transparent px-0 py-0.5 w-full">
          {(turn.activities.length > 0 || turn.isLive || (turn.durationMs ?? 0) > 0) && (
            <div className="my-2 border-b border-border/50 pb-2 text-xs text-muted-foreground">
              {processIds.length > 0 ? (
                <button
                  type="button"
                  aria-label="工作过程"
                  aria-expanded={process.open}
                  aria-controls={processIds.join(' ')}
                  onClick={() => {
                    onActivityToggle?.()
                    setProcess((previous) => ({ ...previous, open: !previous.open }))
                  }}
                  className="group/process-toggle inline-flex items-center gap-1.5 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
                >
                  {elapsedTime}
                  <span
                    aria-hidden="true"
                    className={cn(
                      'inline-flex size-3.5 shrink-0 opacity-0 transition-[opacity,transform] duration-200 group-hover/process-toggle:opacity-100 group-focus-visible/process-toggle:opacity-100',
                      !process.open && '-rotate-90',
                    )}
                  >
                    <ChevronDown className="size-3.5" />
                  </span>
                </button>
              ) : (
                elapsedTime
              )}
            </div>
          )}
          {segments.map((segment, index) =>
            segment.type === 'collaboration' ? (
              <AgentCollaborationRow key={`collaboration-${segment.item.id}`} item={segment.item} />
            ) : (
              <div
                key={segment.type === 'activity' ? `activity-${segment.items[0]!.id}` : `text-${index}`}
                id={`${processId}-${index}`}
                aria-hidden={index !== replyIndex && !process.open}
                inert={index !== replyIndex && !process.open}
                className={cn(
                  'grid transition-[grid-template-rows,opacity] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
                  index === replyIndex || process.open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  {index === segments.length - 1 && hasTrailingText && turn.images.length > 0 && (
                    <AttachmentPreview images={turn.images} />
                  )}
                  {segment.type === 'text' ? (
                    <MarkdownContent isStreaming={turn.isLive && index === segments.length - 1}>
                      {segment.text}
                    </MarkdownContent>
                  ) : (
                    <ActivityGroup
                      items={segment.items}
                      isLive={turn.isLive && index === segments.length - 1}
                      isPaused={isPaused}
                      showElapsedTime={false}
                      collapsed={!process.open}
                      onToggle={onActivityToggle}
                    />
                  )}
                </div>
              </div>
            ),
          )}
          {!hasTrailingText && turn.images.length > 0 && <AttachmentPreview images={turn.images} />}
          {(retry?.errorMessage || turn.errorMessage) && (
            <ErrorLine
              className="mt-2"
              message={retry?.errorMessage || turn.errorMessage!}
              suffix={retry ? `重试中（${retry.attempt}/${retry.maxAttempts}）` : undefined}
            />
          )}
        </div>
        {hasReplyContent && (
          <div className="mt-1 flex h-7 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <MessageActions
              onCopy={() => navigator.clipboard.writeText(turn.finalText)}
              onCopyError={onCopyError}
              canCopy={Boolean(turn.finalText.trim())}
              canEdit={false}
              onFork={onFork && typeof turn.startedAt === 'number' ? () => onFork(turn.startedAt!) : undefined}
              canFork={Boolean(canFork && !turn.isLive && typeof turn.startedAt === 'number')}
            />
            <PluginMessageActions
              role="assistant"
              entries={(turn.finalReplyMessages?.length
                ? turn.finalReplyMessages
                : (turn.sourceMessages ?? [])
              ).flatMap((message) => (message.sourceEntry ? [message.sourceEntry] : []))}
              displayedText={turn.finalText}
              state={turn.errorMessage ? 'error' : 'complete'}
            />
          </div>
        )}
      </div>
    </article>
  )
}
