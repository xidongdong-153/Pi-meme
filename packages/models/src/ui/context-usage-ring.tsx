import * as React from 'react'
import type { PiSessionStats } from '@pi-meme/contracts/pi'
import type { ContextRequest } from '@pi-meme/contracts/context-window'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { tooltipSurfaceClassName } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'
import { formatTokenCount } from './thinking-config'
import { GenerationMetrics, type GenerationMetricsSource } from './generation-metrics'
import { MetricLabel } from './metric-label'

const colors = {
  system: 'light-dark(#7c3aed, #c4b5fd)',
  tools: 'light-dark(#0284c7, #7dd3fc)',
  skills: 'var(--color-muted)',
  memory: 'light-dark(#b45309, #fcd34d)',
  files: 'var(--color-success)',
  results: 'light-dark(#c2410c, #fdba74)',
  chat: 'var(--color-accent)',
}
const labels = {
  system: '系统提示',
  tools: '工具',
  skills: '技能',
  memory: '记忆',
  files: '文件',
  results: '工具结果',
  chat: '对话',
}

export function ContextUsageRing({
  stats,
  generationMetrics,
  context,
  onOpenContext,
}: {
  stats?: PiSessionStats | null
  generationMetrics?: GenerationMetricsSource
  context?: ContextRequest
  onOpenContext?: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hoverPausedUntil = React.useRef(0)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const clearHoverTimer = () => clearTimeout(hoverTimer.current)
  React.useEffect(() => () => clearTimeout(hoverTimer.current), [])
  const onOpenChange = (value: boolean) => {
    clearHoverTimer()
    setOpen(value)
  }
  const scheduleOpen = () => {
    clearHoverTimer()
    if (performance.now() < hoverPausedUntil.current) return
    hoverTimer.current = setTimeout(setOpen, 150, true)
  }
  const scheduleClose = () => {
    clearHoverTimer()
    hoverTimer.current = setTimeout(() => {
      if (!contentRef.current?.contains(document.activeElement)) setOpen(false)
    }, 250)
  }
  const prompt = context?.prompt
  const tokens =
    prompt?.tokens ??
    (context
      ? context.usage
        ? context.usage.input + context.usage.cacheRead + context.usage.cacheWrite
        : undefined
      : stats?.contextUsage?.tokens)
  const window = prompt?.window ?? (context ? undefined : stats?.contextUsage?.contextWindow)
  const hasUsage = typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0
  const used = hasUsage ? Math.round(tokens) : 0
  const capacity = typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : 0
  const percent = hasUsage && capacity ? Math.min(100, Math.max(0, Math.round((used / capacity) * 100))) : undefined
  const counted = prompt ? prompt.counted : Boolean(context?.usage)
  const usedLabel = hasUsage ? `${counted ? '' : '~'}${formatTokenCount(used)}` : '—'
  const parts = prompt?.parts.filter((part) => part.tokens > 0) ?? []
  const size = 18
  const center = size / 2
  const radius = center - 2.2
  const circumference = 2 * Math.PI * radius

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="上下文窗口占用"
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse') scheduleOpen()
          }}
          onPointerLeave={scheduleClose}
          className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              className="text-muted-foreground/35"
            />
            {percent !== undefined && percent > 0 && (
              <circle
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={2.2}
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - percent / 100)}
                strokeLinecap="round"
                className={percent > 85 ? 'text-destructive' : percent > 65 ? 'text-amber-500' : 'text-primary/70'}
              />
            )}
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        aria-label="上下文与生成指标"
        side="top"
        align="end"
        sideOffset={8}
        onPointerEnter={clearHoverTimer}
        onPointerLeave={scheduleClose}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className={cn(tooltipSurfaceClassName, 'w-72 max-w-[calc(100vw-2rem)] space-y-2 p-3 select-none')}
      >
        <div className="flex items-center justify-between text-xs">
          <div>
            <span className="text-muted-foreground">
              <MetricLabel
                label="上下文已用"
                description="最近一次主请求的输入占用；没有快照时使用 SDK 上下文估算。容量来自模型目录。"
              />{' '}
            </span>
            <span className="font-semibold">
              {percent === undefined ? (hasUsage ? '容量未知' : '待统计') : `${percent}%`}
            </span>
          </div>
          <div className="text-muted-foreground/80 font-mono text-[0.6875rem]">
            {capacity ? `${usedLabel} / ${formatTokenCount(capacity)}` : usedLabel}
          </div>
        </div>
        {parts.length > 0 && (
          <>
            <div className="flex h-1 w-full overflow-hidden rounded-full bg-secondary">
              {parts.map((part) => (
                <div
                  key={part.kind}
                  className="h-full"
                  style={{
                    background: colors[part.kind],
                    width: `${(part.tokens / (capacity || Math.max(used, 1))) * 100}%`,
                  }}
                />
              ))}
            </div>
            <div className="flex flex-col gap-1.5 pt-0.5 text-xs">
              {parts.map((part) => (
                <div key={part.kind} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="size-2 shrink-0 rounded-[2px]" style={{ background: colors[part.kind] }} />
                    {labels[part.kind]}
                  </div>
                  <span className="font-mono text-[0.6875rem] text-muted-foreground">
                    {formatTokenCount(part.tokens)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
        {onOpenContext && (
          <button
            type="button"
            className="w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              hoverPausedUntil.current = performance.now() + 600
              onOpenChange(false)
              onOpenContext()
            }}
          >
            查看上下文窗口
          </button>
        )}
        {generationMetrics && <GenerationMetrics source={generationMetrics} />}
      </PopoverContent>
    </Popover>
  )
}
