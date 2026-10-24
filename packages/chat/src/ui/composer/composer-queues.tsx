import { useState } from 'react'
import { CornerDownRight, Ellipsis, ListEnd, Pencil, Play, Trash2 } from 'lucide-react'
import type { ComposerProps } from './composer'
import type { MessageConfiguration } from '@pi-meme/contracts/plan'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'

export function ComposerQueues({
  queues,
  paused,
  activeMode,
  activeConfiguration,
  disabled,
  onResume,
  onSteerQueueInput,
  onDeleteQueueInput,
  onEditQueueInput,
}: Pick<
  ComposerProps,
  | 'queues'
  | 'paused'
  | 'activeMode'
  | 'disabled'
  | 'onResume'
  | 'onSteerQueueInput'
  | 'onDeleteQueueInput'
  | 'onEditQueueInput'
> & { activeConfiguration?: MessageConfiguration }) {
  const [menuId, setMenuId] = useState<string | null>(null)
  const inputs = [...queues.steering, ...queues.followUp]
  if (!inputs.length) return null
  const actionClass =
    'inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-full px-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40'
  return (
    <div
      aria-label="待处理任务队列"
      style={{ backgroundColor: 'color-mix(in srgb, var(--background), var(--foreground) 10%)' }}
      className="relative mx-3 -mb-2 rounded-t-2xl border border-b-0 border-border/80 pb-2 text-xs"
    >
      {paused && (
        <div className="flex min-h-9 min-w-0 items-center justify-end border-b border-border/70 px-3 text-muted-foreground">
          <button type="button" aria-label="继续队列" className={actionClass} disabled={disabled} onClick={onResume}>
            <Play className="size-3 fill-current" />
            继续队列
          </button>
        </div>
      )}
      {inputs.map((input) => {
        const differentMode = activeMode !== undefined && input.mode !== activeMode
        const differentConfiguration = Boolean(
          input.configuration &&
          activeConfiguration &&
          ((input.configuration.model &&
            (input.configuration.model.provider !== activeConfiguration.model?.provider ||
              input.configuration.model.id !== activeConfiguration.model?.id)) ||
            (input.configuration.thinkingLevel !== undefined &&
              input.configuration.thinkingLevel !== activeConfiguration.thinkingLevel)),
        )
        const guideDisabled =
          disabled || input.editing || input.deliveryUncertain || differentMode || differentConfiguration
        return (
          <div key={input.id} data-queue-id={input.id} className="flex h-9 min-w-0 items-center gap-2 px-3">
            <ListEnd className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate" title={input.text}>
              {input.editing ? '正在编辑：' : ''}
              {input.text || (input.skills?.length ? '技能消息' : '图片消息')}
            </span>
            {input.images?.slice(0, 1).map((image, index) => (
              <img
                key={index}
                src={`data:${image.mimeType};base64,${image.data}`}
                alt="排队图片"
                className="size-6 shrink-0 rounded object-cover"
              />
            ))}
            {(input.images?.length ?? 0) > 1 && (
              <span className="shrink-0 text-muted-foreground">+{input.images!.length - 1}</span>
            )}
            {input.submitted ? (
              <span className="shrink-0 text-muted-foreground">已引导，等待当前工具结束</span>
            ) : (
              <>
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <span className="shrink-0">
                      <button
                        type="button"
                        aria-label="引导"
                        disabled={guideDisabled}
                        className={actionClass}
                        onClick={() => onSteerQueueInput?.(input.id)}
                      >
                        <CornerDownRight className="size-3.5" />
                        <span>引导</span>
                      </button>
                    </span>
                  </TooltipTrigger>
                  {!input.deliveryUncertain && !differentConfiguration && (
                    <TooltipContent side="top">
                      {differentMode ? '消息模式与当前任务不同，暂时无法引导' : '提交，但不中断模型运行'}
                    </TooltipContent>
                  )}
                </Tooltip>
                <button
                  type="button"
                  aria-label="删除排队消息"
                  disabled={disabled || input.editing}
                  className={actionClass}
                  onClick={() => onDeleteQueueInput?.(input.id)}
                >
                  <Trash2 className="size-3.5" />
                </button>
                <DropdownMenu open={menuId === input.id} onOpenChange={(open) => setMenuId(open ? input.id : null)}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="排队消息更多操作"
                      disabled={disabled || input.editing}
                      className={actionClass}
                    >
                      <Ellipsis className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  {menuId === input.id && (
                    <DropdownMenuContent
                      align="end"
                      side="bottom"
                      className="rounded-2xl"
                      style={{ backgroundColor: 'color-mix(in srgb, var(--background), var(--foreground) 10%)' }}
                    >
                      <DropdownMenuItem onSelect={() => onEditQueueInput?.(input.id)}>
                        <Pencil />
                        编辑消息
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  )}
                </DropdownMenu>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
