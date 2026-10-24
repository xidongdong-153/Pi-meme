import * as React from 'react'
import type { PiSessionStats } from '@pi-meme/contracts/pi'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { formatTokenCount } from './thinking-config'
import { GenerationMetrics, type GenerationMetricsSource } from './generation-metrics'
import { MetricLabel } from './metric-label'

export function ContextUsageRing({
  stats,
  generationMetrics,
}: {
  stats?: PiSessionStats | null
  generationMetrics?: GenerationMetricsSource
}) {
  const [open, setOpen] = React.useState(false)
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const clearHoverTimer = () => clearTimeout(hoverTimer.current)
  React.useEffect(() => () => clearTimeout(hoverTimer.current), [])
  const onOpenChange = (value: boolean) => {
    clearHoverTimer()
    setOpen(value)
  }
  const scheduleOpen = () => {
    clearHoverTimer()
    hoverTimer.current = setTimeout(setOpen, 150, true)
  }
  const scheduleClose = () => {
    clearHoverTimer()
    hoverTimer.current = setTimeout(() => {
      if (!contentRef.current?.contains(document.activeElement)) setOpen(false)
    }, 250)
  }
  const usage = stats?.contextUsage
  const tokens = usage?.tokens
  const percent = usage?.percent
  const hasUsage =
    typeof tokens === 'number' &&
    Number.isFinite(tokens) &&
    tokens >= 0 &&
    typeof percent === 'number' &&
    Number.isFinite(percent) &&
    percent >= 0
  const usedTokens = hasUsage ? Math.round(tokens) : 0
  const contextWindow = usage?.contextWindow ?? 0
  const maxTokens = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.round(contextWindow) : 0
  const usedTokensLabel = hasUsage ? `~${formatTokenCount(usedTokens)}` : '—'

  // 严格整数百分比，绝无小数点
  const displayPercent = hasUsage ? Math.min(100, Math.round(percent)) : 0

  // 估算或提取三个组成部分的 token 数量（系统提示词、工具定义、对话消息），并确保三者之和为 usedTokens
  const breakdown = React.useMemo(() => {
    if (usedTokens <= 0) {
      return { systemTokens: 0, toolsTokens: 0, messagesTokens: 0 }
    }

    // 系统提示词基准 ~1.7K，工具定义基准 ~8.1K
    if (usedTokens >= 10000) {
      const system = 1700
      const tools = 8100
      const messages = Math.max(0, usedTokens - system - tools)
      return { systemTokens: system, toolsTokens: tools, messagesTokens: messages }
    }

    // 较小总数时按比例分配
    const system = Math.round(usedTokens * 0.18)
    const tools = Math.round(usedTokens * 0.62)
    const messages = Math.max(0, usedTokens - system - tools)
    return { systemTokens: system, toolsTokens: tools, messagesTokens: messages }
  }, [usedTokens])

  // 各分段在整个窗口中的宽度比例
  const windowSize = maxTokens > 0 ? maxTokens : Math.max(usedTokens, 1)
  const systemPercent = (breakdown.systemTokens / windowSize) * 100
  const toolsPercent = (breakdown.toolsTokens / windowSize) * 100
  const messagesPercent = (breakdown.messagesTokens / windowSize) * 100

  const size = 18
  const strokeWidth = 2.2
  const center = size / 2
  const radius = center - strokeWidth
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (Math.min(Math.max(displayPercent, 0), 100) / 100) * circumference

  const hasData = displayPercent > 0 || usedTokens > 0

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="背景信息窗口占用"
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse') scheduleOpen()
          }}
          onPointerLeave={scheduleClose}
          className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-secondary/60 focus:outline-hidden cursor-default"
        >
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={strokeWidth}
              className="text-muted-foreground/35"
            />
            {hasData && (
              <circle
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={strokeWidth}
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                strokeLinecap="round"
                className={
                  displayPercent > 85 ? 'text-destructive' : displayPercent > 65 ? 'text-amber-500' : 'text-primary/70'
                }
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
        className="w-72 max-w-[calc(100vw-2rem)] space-y-2 rounded-2xl border border-border/80 bg-popover p-3 shadow-xl select-none"
      >
        {/* 顶部标题与整体指标 */}
        <div className="flex items-center justify-between text-xs font-normal">
          <div>
            <span className="text-muted-foreground">
              <MetricLabel
                label="上下文已用"
                description="当前上下文占模型可用窗口的比例。右侧显示已用 token 和上下文上限。"
              />{' '}
            </span>
            <span className="font-semibold text-foreground">{hasUsage ? `${displayPercent}%` : '待统计'}</span>
          </div>
          <div className="text-muted-foreground/80 font-mono text-[0.6875rem]">
            {maxTokens > 0 ? `${usedTokensLabel} / ${formatTokenCount(maxTokens)}` : usedTokensLabel}
          </div>
        </div>

        {/* 多段连续横向进度条 */}
        <div className="h-1 w-full rounded-full bg-white/10 flex overflow-hidden">
          {systemPercent > 0 && <div className="h-full bg-slate-300" style={{ width: `${systemPercent}%` }} />}
          {toolsPercent > 0 && <div className="h-full bg-purple-400" style={{ width: `${toolsPercent}%` }} />}
          {messagesPercent > 0 && <div className="h-full bg-blue-500" style={{ width: `${messagesPercent}%` }} />}
        </div>

        {/* 分项 Token 列表 */}
        <div className="flex flex-col gap-1.5 pt-0.5 text-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-[2px] bg-slate-300 shrink-0" />
              <span className="text-foreground/90">
                <MetricLabel
                  label="系统提示词"
                  description="指导模型行为的系统指令。此处分项按上下文总量估算，不代表模型返回的精确用量。"
                />
              </span>
            </div>
            <span className="text-muted-foreground/90 font-mono text-[0.6875rem]">
              {hasUsage ? `~${formatTokenCount(breakdown.systemTokens)}` : '—'}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-[2px] bg-purple-400 shrink-0" />
              <span className="text-foreground/90">
                <MetricLabel
                  label="工具定义"
                  description="发送给模型的工具名称、说明和参数结构。此处分项按上下文总量估算。"
                />
              </span>
            </div>
            <span className="text-muted-foreground/90 font-mono text-[0.6875rem]">
              {hasUsage ? `~${formatTokenCount(breakdown.toolsTokens)}` : '—'}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-[2px] bg-blue-500 shrink-0" />
              <span className="text-foreground/90">
                <MetricLabel
                  label="对话消息"
                  description="用户消息、模型回复和工具结果等内容的上下文占用。此处分项按上下文总量估算。"
                />
              </span>
            </div>
            <span className="text-muted-foreground/90 font-mono text-[0.6875rem]">
              {hasUsage ? `~${formatTokenCount(breakdown.messagesTokens)}` : '—'}
            </span>
          </div>
        </div>
        {generationMetrics && <GenerationMetrics source={generationMetrics} />}
      </PopoverContent>
    </Popover>
  )
}
