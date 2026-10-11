import * as React from 'react'
import type { PiSessionStats } from '@pi-meme/contracts/pi'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { formatTokenCount } from './thinking-config'

export function ContextUsageRing({ stats }: { stats?: PiSessionStats | null }) {
  const usage = stats?.contextUsage
  const percent = usage?.percent ?? 0
  const usedTokens = Math.round(usage?.tokens ?? stats?.tokens.total ?? 0)
  const maxTokens = Math.round(usage?.contextWindow ?? (usedTokens > 0 ? 256000 : 0))

  // 严格整数百分比，绝无小数点
  const displayPercent = Math.min(100, Math.max(0, Math.round(percent)))

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
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="背景信息窗口占用"
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
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-64 p-3 bg-popover/95 backdrop-blur-md shadow-2xl border border-border/80 rounded-xl space-y-2 select-none"
      >
        {/* 顶部标题与整体指标 */}
        <div className="flex items-center justify-between text-xs font-normal">
          <div>
            <span className="text-muted-foreground">上下文已用 </span>
            <span className="font-semibold text-foreground">{displayPercent}%</span>
          </div>
          <div className="text-muted-foreground/80 font-mono text-[0.6875rem]">
            {maxTokens > 0
              ? `~${formatTokenCount(usedTokens)} / ${formatTokenCount(maxTokens)}`
              : `~${formatTokenCount(usedTokens)}`}
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
              <span className="text-foreground/90">系统提示词</span>
            </div>
            <span className="text-muted-foreground/90 font-mono text-[0.6875rem]">
              ~{formatTokenCount(breakdown.systemTokens)}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-[2px] bg-purple-400 shrink-0" />
              <span className="text-foreground/90">工具定义</span>
            </div>
            <span className="text-muted-foreground/90 font-mono text-[0.6875rem]">
              ~{formatTokenCount(breakdown.toolsTokens)}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-[2px] bg-blue-500 shrink-0" />
              <span className="text-foreground/90">对话消息</span>
            </div>
            <span className="text-muted-foreground/90 font-mono text-[0.6875rem]">
              ~{formatTokenCount(breakdown.messagesTokens)}
            </span>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
