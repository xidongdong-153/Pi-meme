import { VisualizationRenderer } from '@pi-meme/ui/components/visualization-renderer'
import { MarkdownHiddenImagesContext, MarkdownHiddenVisualizationsContext } from '../content/markdown-components'
import { insertTurnVisualizations } from '../model/turn-visualizations'
import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import type { PiPauseInterval, PiRetryState } from '@pi-meme/contracts/pi'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import { ErrorLine } from '@pi-meme/ui/components/error-line'
import type { ActivityItem, TurnChunk } from '../model/types'
import { AttachmentPreview } from '../content/attachment-preview'
import { MarkdownContent } from '../content/markdown-content'
import { ActivityElapsedTime, ActivityGroup } from './activity-group'
import { groupAgentActivities } from '../model/agent-collaboration'
import { AgentCollaborationRow } from './agent-collaboration-row'
import { AgentStatusRow } from './agent-status-row'
import { AgentOperationRow } from './agent-operation-row'
import { QuestionAnswerRow } from './question-answer-row'
import { ToolActivityRow } from './tool-activity-row'
import { cn } from '@pi-meme/ui/lib/utils'
import { MessageActions } from './message-actions'
import { MessageTime } from './message-time'
import { PluginMessageActions } from '@pi-meme/ui/components/plugin-message-actions'
import { collectImageGenerations, type TurnImageGeneration } from '../model/turn-image-generations'
import { TurnImageGallery } from './turn-image-gallery'
import { RetainedDisclosure } from './retained-disclosure'

const emptyAgents: readonly AgentSummary[] = []
export const AssistantTurnView = React.memo(AssistantTurnContent)

function InlineImageActivity({
  item,
  isLive,
  isPaused,
  onToggle,
}: {
  item: Exclude<ActivityItem, { type: 'thinking' | 'narration' }>
  isLive: boolean
  isPaused: boolean
  onToggle?: () => void
}) {
  const [open, setOpen] = React.useState(true)
  return (
    <ToolActivityRow
      item={item}
      open={open}
      onToggle={() => {
        onToggle?.()
        setOpen((value) => !value)
      }}
      isLive={isLive}
      isPaused={isPaused}
    />
  )
}

function AssistantTurnContent({
  turn,
  isFinalReply = !turn.isLive,
  hideAgentOperations = turn.hideAgentOperations,
  className,
  isPaused = false,
  pauseIntervals,
  canFork,
  onFork,
  onCopyError,
  onOpenAgent,
  agents = emptyAgents,
  caller,
  retry,
  onActivityToggle,
  reply,
  changes,
  imageGenerations,
}: {
  turn: Extract<TurnChunk, { type: 'assistant_turn' }>
  isFinalReply?: boolean
  hideAgentOperations?: boolean
  className?: string
  isPaused?: boolean
  pauseIntervals?: PiPauseInterval[]
  canFork?: boolean
  onFork?: (timestamp: number) => void
  onCopyError?: (message: string) => void
  onOpenAgent?: (agentId: string) => void
  agents?: readonly AgentSummary[]
  caller?: AgentSummary
  retry?: PiRetryState
  onActivityToggle?: () => void
  reply?: React.ReactNode
  changes?: React.ReactNode
  imageGenerations?: readonly TurnImageGeneration[]
}) {
  const generated = React.useMemo(
    () => imageGenerations ?? collectImageGenerations(turn.activities),
    [imageGenerations, turn.activities],
  )
  const hiddenImagePaths = React.useMemo(
    () => new Set(generated.flatMap((item) => (item.image && item.path ? [item.path] : []))),
    [generated],
  )
  const hasReplyContent =
    !reply && isFinalReply && !turn.isLive && (Boolean(turn.finalText.trim()) || turn.images.length > 0)
  const segments = React.useMemo(
    () =>
      insertTurnVisualizations(
        groupAgentActivities(
          turn.activities,
          turn.finalText,
          turn.collaboration,
          hideAgentOperations,
          turn.agentStatuses,
        ),
      ),
    [turn.activities, turn.finalText, turn.collaboration, hideAgentOperations, turn.agentStatuses],
  )
  const visualizationKeys = React.useMemo(
    () =>
      new Set(
        segments.flatMap((segment) =>
          segment.type === 'visualization' ? [`${segment.reference.id}:${segment.reference.revision}`] : [],
        ),
      ),
    [segments],
  )
  const firstReplyIndex = segments.findIndex((segment) => segment.type === 'text' && segment.finalReply)
  const lastTextIndex = segments.findLastIndex((segment) => segment.type === 'text')
  const lastActivityIndex = segments.findLastIndex((segment) => segment.type === 'activity')
  const processId = React.useId()
  const processIds = segments.flatMap((segment, index) =>
    (segment.type === 'text' && segment.finalReply) || segment.type === 'visualization' || segment.type === 'question'
      ? []
      : [`${processId}-${index}`],
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

  const content = (
    <article
      data-message-role="assistant"
      className={cn('group flex w-full py-1 text-sm select-text justify-start', className)}
    >
      <div className="flex flex-col min-w-0 w-full items-start">
        <div className="text-foreground bg-transparent px-0 py-0.5 w-full">
          {(processIds.length > 0 || turn.isLive || (turn.durationMs ?? 0) > 0) && (
            <div className="conversation-process-header text-muted-foreground">
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
                  className="group/process-toggle inline-flex min-h-6 items-center gap-1.5 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
                >
                  <span>工作过程 · {elapsedTime}</span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      'inline-flex size-3.5 shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none',
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
          {segments.map((segment, index) => {
            if (segment.type === 'visualization')
              return (
                <div
                  key={`visualization-${segment.reference.id}:${segment.reference.revision}`}
                  className="conversation-block"
                  aria-label="生成的草图"
                >
                  <VisualizationRenderer reference={segment.reference} />
                </div>
              )
            const finalReply = segment.type === 'text' && Boolean(segment.finalReply)
            if (finalReply && reply && index !== firstReplyIndex) return null
            const open = finalReply || segment.type === 'question' || process.open
            const key =
              segment.type === 'activity'
                ? `activity-${segment.items[0]!.id}`
                : segment.type === 'collaboration'
                  ? `collaboration-${segment.item.id}`
                  : segment.type === 'agent_status'
                    ? segment.item.key
                    : segment.type === 'agent_operation' ||
                        segment.type === 'question' ||
                        segment.type === 'image_activity'
                      ? `${segment.type}-${segment.item.id}`
                      : `text-${index}`
            return (
              <RetainedDisclosure
                open={open}
                key={key}
                id={`${processId}-${index}`}
                aria-hidden={!open}
                inert={!open}
                className={cn(
                  'grid transition-[grid-template-rows,opacity] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                  open ? 'conversation-block grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  {index === firstReplyIndex && turn.images.length > 0 && <AttachmentPreview images={turn.images} />}
                  {segment.type === 'agent_operation' ? (
                    <AgentOperationRow
                      item={segment.item}
                      agents={agents}
                      caller={caller}
                      isLive={turn.isLive}
                      isPaused={isPaused}
                      onOpenAgent={onOpenAgent}
                    />
                  ) : segment.type === 'question' ? (
                    <QuestionAnswerRow item={segment.item} isLive={turn.isLive} isPaused={isPaused} />
                  ) : segment.type === 'image_activity' ? (
                    <InlineImageActivity
                      item={segment.item}
                      isLive={turn.isLive}
                      isPaused={isPaused}
                      onToggle={onActivityToggle}
                    />
                  ) : segment.type === 'collaboration' ? (
                    <AgentCollaborationRow item={segment.item} onOpenAgent={onOpenAgent} />
                  ) : segment.type === 'agent_status' ? (
                    <AgentStatusRow
                      agents={segment.item.agents}
                      status={segment.item.status}
                      onOpenAgent={onOpenAgent}
                    />
                  ) : segment.type === 'text' ? (
                    finalReply && reply ? (
                      reply
                    ) : (
                      <MarkdownContent
                        isStreaming={turn.isLive && index === lastTextIndex}
                        imagePresentation={finalReply ? 'inline' : 'activity'}
                      >
                        {segment.text}
                      </MarkdownContent>
                    )
                  ) : (
                    <ActivityGroup
                      items={segment.items}
                      isLive={turn.isLive && index === lastActivityIndex}
                      isPaused={isPaused}
                      showElapsedTime={false}
                      collapsed={!process.open}
                      onToggle={onActivityToggle}
                    />
                  )}
                </div>
              </RetainedDisclosure>
            )
          })}
          {firstReplyIndex === -1 && reply && <div className="conversation-block">{reply}</div>}
          {firstReplyIndex === -1 && turn.images.length > 0 && (
            <div className="conversation-block">
              <AttachmentPreview images={turn.images} />
            </div>
          )}
          <TurnImageGallery generations={generated} isLive={turn.isLive} isPaused={isPaused} />
          {(retry?.errorMessage || turn.errorMessage) && (
            <ErrorLine
              className="mt-2"
              message={retry?.errorMessage || turn.errorMessage!}
              suffix={retry ? `重试中（${retry.attempt}/${retry.maxAttempts}）` : undefined}
            />
          )}
        </div>
        {changes}
        {hasReplyContent && (
          <div className="mt-1 flex h-7 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <MessageActions
              onCopy={() => navigator.clipboard.writeText(turn.finalText)}
              onCopyError={onCopyError}
              canCopy={Boolean(turn.finalText.trim())}
              canEdit={false}
              onFork={onFork && typeof turn.userTimestamp === 'number' ? () => onFork(turn.userTimestamp!) : undefined}
              canFork={Boolean(canFork && !turn.isLive && typeof turn.userTimestamp === 'number')}
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
            <MessageTime timestamp={turn.repliedAt} />
          </div>
        )}
      </div>
    </article>
  )
  return (
    <MarkdownHiddenVisualizationsContext.Provider value={visualizationKeys}>
      <MarkdownHiddenImagesContext value={hiddenImagePaths}>{content}</MarkdownHiddenImagesContext>
    </MarkdownHiddenVisualizationsContext.Provider>
  )
}
