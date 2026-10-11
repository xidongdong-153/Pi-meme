import type { ReactNode } from 'react'
import { ArrowUp, CornerDownLeft, Lightbulb, Play, Plus, Square, X } from 'lucide-react'
import type { TaskMode } from '@pi-meme/contracts/plan'
import type { PiState } from '@pi-meme/contracts/pi'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'

export type ComposerToolbarProps = {
  compact?: boolean
  mode?: TaskMode
  onMode?: (mode: TaskMode) => void
  paused?: boolean
  editingQueue?: boolean
  onResume?: () => void
  running: boolean
  disabled: boolean
  draft: string
  hasAttachments: boolean
  queueMode: 'steering' | 'followUp'
  onQueueMode: (mode: 'steering' | 'followUp') => void
  steeringMode?: PiState['steeringMode']
  followUpMode?: PiState['followUpMode']
  onSteeringMode: (mode: PiState['steeringMode']) => void
  onFollowUpMode: (mode: PiState['followUpMode']) => void
  onStop: () => void
  onAddFiles?: () => void
  model: ReactNode
  access: ReactNode
  contextUsage: ReactNode
  editing: boolean
}

export function ComposerToolbar({
  compact,
  mode,
  onMode,
  running,
  paused,
  editingQueue,
  onResume,
  disabled,
  draft,
  hasAttachments,
  onStop,
  onAddFiles,
  model,
  access,
  contextUsage,
  editing,
}: ComposerToolbarProps) {
  const canSend = !disabled && (Boolean(draft.trim()) || hasAttachments)
  const plan =
    mode === 'plan' && onMode ? (
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="关闭计划模式"
            onClick={() => onMode('default')}
            className="group inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2 text-xs text-foreground transition-colors hover:bg-secondary/70 cursor-pointer select-none"
          >
            <Lightbulb className="size-4 group-hover:hidden group-focus-visible:hidden" />
            <span className="hidden size-4 items-center justify-center rounded-full bg-muted-foreground/20 group-hover:flex group-focus-visible:flex">
              <X className="size-3" />
            </span>
            <span>计划</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">关闭计划模式</TooltipContent>
      </Tooltip>
    ) : null

  return (
    <div className="composer-toolbar mt-2 flex flex-wrap items-center justify-between pt-1 gap-2">
      <div className="composer-leading flex min-w-0 flex-wrap items-center gap-1.5">
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              onClick={onAddFiles}
              aria-label="添加附件"
              className={cn(
                'inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/70 transition-colors cursor-pointer select-none',
                compact && 'rounded-full text-foreground',
                disabled && 'cursor-not-allowed',
              )}
            >
              <Plus className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">添加图片或附件</TooltipContent>
        </Tooltip>
        {!compact && access}
        {!compact && plan && (
          <>
            <span aria-hidden="true" className="mx-0.5 h-3 w-px shrink-0 bg-border" />
            {plan}
          </>
        )}
      </div>
      <div className="composer-controls ml-auto flex min-w-0 shrink-0 items-center justify-end gap-1.5">
        <div className="composer-context">{contextUsage}</div>
        <div className="composer-model flex min-w-0 max-w-[220px] items-center">{model}</div>
        {compact && access}
        {compact && plan}
        <button
          type={canSend || editingQueue ? 'submit' : 'button'}
          disabled={disabled || (editingQueue ? !canSend : !canSend && !running && !paused)}
          onClick={!canSend && !editingQueue ? (paused ? onResume : running ? onStop : undefined) : undefined}
          aria-label={
            editingQueue
              ? '保存排队消息'
              : canSend
                ? editing
                  ? '重新发送消息'
                  : running || paused
                    ? '发送排队任务'
                    : '发送消息'
                : paused
                  ? '继续当前任务'
                  : running
                    ? '暂停当前任务'
                    : '发送消息'
          }
          title={
            editingQueue
              ? '保存排队消息'
              : canSend
                ? '发送 (Enter)'
                : paused
                  ? '继续当前任务'
                  : running
                    ? '暂停当前任务'
                    : '发送 (Enter)'
          }
          className={cn(
            'inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[#2f6bca] text-white transition-all shadow-xs cursor-pointer hover:bg-[#3675d8] active:scale-95',
            compact && 'size-7',
            (disabled || (editingQueue ? !canSend : !canSend && !running && !paused)) &&
              'opacity-40 cursor-not-allowed hover:bg-[#2f6bca] active:scale-100',
          )}
        >
          {!canSend && paused && !editingQueue ? (
            <Play className="size-3.5 fill-current" />
          ) : !canSend && running && !editingQueue ? (
            <Square className="size-3.5 fill-current" />
          ) : (running || paused) && !editingQueue ? (
            <CornerDownLeft className="size-4" />
          ) : (
            <ArrowUp className="size-4 stroke-[2.5]" />
          )}
        </button>
      </div>
    </div>
  )
}
