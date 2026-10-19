import type { PiPauseInterval, PiRetryState } from '@pi-meme/contracts/pi'
import { ErrorLine } from '@pi-meme/ui/components/error-line'
import type { TurnChunk } from '../model/types'
import { AttachmentPreview } from '../content/attachment-preview'
import { MarkdownContent } from '../content/markdown-content'
import { ActivityGroup } from './activity-group'
import { cn } from '@pi-meme/ui/lib/utils'
import { MessageActions } from './message-actions'

export function AssistantTurnView({
  turn,
  className,
  isPaused = false,
  pauseIntervals,
  canFork,
  onFork,
  onCopyError,
  retry,
}: {
  turn: Extract<TurnChunk, { type: 'assistant_turn' }>
  className?: string
  isPaused?: boolean
  pauseIntervals?: PiPauseInterval[]
  canFork?: boolean
  onFork?: (timestamp: number) => void
  onCopyError?: (message: string) => void
  retry?: PiRetryState
}) {
  const hasReplyContent = Boolean(turn.finalText.trim()) || turn.images.length > 0

  return (
    <article
      data-message-role="assistant"
      className={cn('group flex w-full py-1 text-sm select-text transition-all justify-start', className)}
    >
      <div className="flex flex-col min-w-0 w-full items-start">
        <div className="text-sm text-foreground leading-relaxed bg-transparent px-0 py-0.5 w-full">
          {(turn.activities.length > 0 || turn.isLive || (turn.durationMs ?? 0) > 0) && (
            <ActivityGroup
              items={turn.activities}
              isLive={turn.isLive}
              durationMs={turn.durationMs}
              startedAt={turn.startedAt}
              isPaused={isPaused}
              pauseIntervals={pauseIntervals}
            />
          )}

          {turn.images.length > 0 && <AttachmentPreview images={turn.images} />}

          {turn.finalText ? <MarkdownContent isStreaming={turn.isLive}>{turn.finalText}</MarkdownContent> : null}
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
          </div>
        )}
      </div>
    </article>
  )
}
