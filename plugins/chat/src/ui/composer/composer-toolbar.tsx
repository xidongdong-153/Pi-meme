import type { ReactNode } from 'react'
import { ArrowUp, CornerDownLeft, Plus, Square } from 'lucide-react'
import type { PiState } from '@pi-meme/contracts/pi'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'
import { QueueModeDropdown } from './queue-mode-dropdown'

export type ComposerToolbarProps = {
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
  running,
  disabled,
  draft,
  hasAttachments,
  queueMode,
  onQueueMode,
  steeringMode,
  followUpMode,
  onSteeringMode,
  onFollowUpMode,
  onStop,
  onAddFiles,
  model,
  access,
  contextUsage,
  editing,
}: ComposerToolbarProps) {
  const canSend = !disabled && (Boolean(draft.trim()) || hasAttachments)

  return (
    <div className="mt-2 flex flex-wrap items-center justify-between pt-1 gap-2">
      {/* 左侧操作组：+ 号添加附件、权限选择器、运行时插话/排队模式 */}
      <div className="flex min-w-0 shrink-0 items-center gap-1.5">
        {/* + 添加附件 */}
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              onClick={onAddFiles}
              aria-label="添加附件"
              className={cn(
                'inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/70 transition-colors cursor-pointer select-none',
                disabled && 'cursor-not-allowed',
              )}
            >
              <Plus className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">添加图片或附件</TooltipContent>
        </Tooltip>

        {access}

        {/* 运行时插话与排队模式下拉切换 */}
        {running && (
          <QueueModeDropdown
            disabled={disabled}
            queueMode={queueMode}
            onQueueMode={onQueueMode}
            steeringMode={steeringMode}
            followUpMode={followUpMode}
            onSteeringMode={onSteeringMode}
            onFollowUpMode={onFollowUpMode}
          />
        )}
      </div>

      {/* 右侧操作组：背景信息窗口占用指示圈、模型与思考强度、发送按钮 */}
      <div className="ml-auto flex min-w-0 shrink-0 items-center justify-end gap-1.5">
        {/* 背景信息窗口占用圆环 */}
        {contextUsage}

        {/* 模型与思考强度胶囊 */}
        <div className="flex min-w-0 max-w-[220px] items-center">{model}</div>

        {/* 运行中的停止按钮 */}
        {running && (
          <button
            type="button"
            onClick={onStop}
            title="停止当前任务"
            aria-label="停止当前任务"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors shadow-2xs cursor-pointer"
          >
            <Square className="size-3.5 fill-current" />
          </button>
        )}

        {/* 发送按钮（实心蓝色圆形，居中白色向上箭头） */}
        <button
          type="submit"
          disabled={!canSend}
          aria-label={
            editing ? '重新发送消息' : running ? (queueMode === 'steering' ? '发送插话' : '发送排队任务') : '发送消息'
          }
          title={
            editing
              ? '重新发送消息'
              : running
                ? queueMode === 'steering'
                  ? '发送插话'
                  : '追加排队任务'
                : '发送 (Enter)'
          }
          className={cn(
            'inline-flex h-8 shrink-0 whitespace-nowrap items-center justify-center rounded-full bg-blue-600 text-white transition-all shadow-xs cursor-pointer',
            editing ? 'gap-1.5 px-2 lg:px-3' : 'w-8',
            'hover:bg-blue-500 active:scale-95',
            !canSend && 'opacity-40 cursor-not-allowed hover:bg-blue-600 active:scale-100',
          )}
        >
          {running ? <CornerDownLeft className="size-4" /> : <ArrowUp className="size-4 stroke-[2.5]" />}
          {editing && <span className="text-xs font-medium hidden lg:inline">重新发送</span>}
        </button>
      </div>
    </div>
  )
}
