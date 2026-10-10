import * as React from 'react'
import type { PiState } from '@pi-meme/contracts/pi'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { Check } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'

export type QueueModeDropdownProps = {
  disabled: boolean
  queueMode: 'steering' | 'followUp'
  onQueueMode: (mode: 'steering' | 'followUp') => void
  steeringMode?: PiState['steeringMode']
  followUpMode?: PiState['followUpMode']
  onSteeringMode: (mode: PiState['steeringMode']) => void
  onFollowUpMode: (mode: PiState['followUpMode']) => void
}

export function QueueModeDropdown({
  disabled,
  queueMode,
  onQueueMode,
  steeringMode,
  followUpMode,
  onSteeringMode,
  onFollowUpMode,
}: QueueModeDropdownProps) {
  const [open, setOpen] = React.useState(false)
  const isSteering = queueMode === 'steering'
  const modeLabel = isSteering ? '插话' : '排队'
  const isAllSteering = steeringMode === 'all'
  const isAllFollowUp = followUpMode === 'all'
  const strategyLabel = isSteering ? (isAllSteering ? '整批插入' : '逐项插入') : isAllFollowUp ? '整批执行' : '逐项执行'

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="运行模式"
          title={`当前模式：${modeLabel}（${strategyLabel}），点击修改`}
          onClick={() => setOpen((prev) => !prev)}
          className={cn(
            'inline-flex h-7 shrink-0 items-center justify-center rounded-md px-2 text-xs font-medium transition-colors cursor-pointer select-none border',
            'bg-secondary/70 hover:bg-secondary text-foreground border-border/40 shadow-2xs',
            'after:content-["▾"] after:ml-1 after:text-[10px] after:text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          {modeLabel}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" className="w-56 p-1.5">
        <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">发送模式</div>
        <DropdownMenuItem
          asChild
          onSelect={() => {
            onQueueMode('steering')
            setOpen(false)
          }}
        >
          <button
            type="button"
            aria-label="插话"
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary cursor-pointer"
          >
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground">插话</span>
              <span className="text-[11px] text-muted-foreground">优先打断并在下一步处理</span>
            </div>
            {isSteering && <Check className="size-3.5 text-primary shrink-0" />}
          </button>
        </DropdownMenuItem>

        <DropdownMenuItem
          asChild
          onSelect={() => {
            onQueueMode('followUp')
            setOpen(false)
          }}
        >
          <button
            type="button"
            aria-label="排队"
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary cursor-pointer"
          >
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground">排队</span>
              <span className="text-[11px] text-muted-foreground">等待当前任务完成后执行</span>
            </div>
            {!isSteering && <Check className="size-3.5 text-primary shrink-0" />}
          </button>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
          {isSteering ? '插话策略' : '排队策略'}
        </div>

        {isSteering ? (
          <DropdownMenuItem
            asChild
            onSelect={() => {
              onSteeringMode(isAllSteering ? 'one-at-a-time' : 'all')
              setOpen(false)
            }}
          >
            <button
              type="button"
              title="点击切换插话模式"
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary cursor-pointer"
            >
              <div className="flex flex-col gap-0.5">
                <span className="font-medium text-foreground">{isAllSteering ? '整批插入' : '逐项插入'}</span>
                <span className="text-[11px] text-muted-foreground">
                  {isAllSteering ? '多条插话合并整批插入' : '多条插话逐项单独插入'}
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground border border-border/60 px-1 py-0.5 rounded">
                点击切换
              </span>
            </button>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            asChild
            onSelect={() => {
              onFollowUpMode(isAllFollowUp ? 'one-at-a-time' : 'all')
              setOpen(false)
            }}
          >
            <button
              type="button"
              title="点击切换排队模式"
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary cursor-pointer"
            >
              <div className="flex flex-col gap-0.5">
                <span className="font-medium text-foreground">{isAllFollowUp ? '整批执行' : '逐项执行'}</span>
                <span className="text-[11px] text-muted-foreground">
                  {isAllFollowUp ? '排队任务合并整批执行' : '排队任务按顺序逐个执行'}
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground border border-border/60 px-1 py-0.5 rounded">
                点击切换
              </span>
            </button>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
