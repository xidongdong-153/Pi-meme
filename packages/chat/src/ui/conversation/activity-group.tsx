import * as React from 'react'
import type { PiPauseInterval } from '@pi-meme/contracts/pi'
import { activeDuration } from '../model/active-duration'
import type { ActivityItem } from '../model/types'
import { cn } from '@pi-meme/ui/lib/utils'
import { BookOpen, ChevronDown, Images, Pencil, Search, Sparkles, SquareTerminal, Wrench } from 'lucide-react'
import { groupAdjacentActivities, summarizeActivities, formatDurationChinese } from '../model/activity-summary'
import { parseToolMeta } from '../model/tool-details'
import { MarkdownContent } from '../content/markdown-content'
import { ThinkingActivityRow } from './thinking-activity-row'
import { ToolActivityRow } from './tool-activity-row'

const activityIcons = {
  command: SquareTerminal,
  read: BookOpen,
  write: Pencil,
  edit: Pencil,
  image: Images,
  search: Search,
  generic: Wrench,
  thinking: Sparkles,
}

export function ActivityGroup({
  items,
  isLive = false,
  isPaused = false,
  pauseIntervals,
  durationMs,
  startedAt,
  showElapsedTime = true,
  collapsed = false,
  onToggle,
  className,
}: {
  items: ActivityItem[]
  isLive?: boolean
  isPaused?: boolean
  pauseIntervals?: PiPauseInterval[]
  durationMs?: number
  startedAt?: number
  showElapsedTime?: boolean
  collapsed?: boolean
  onToggle?: () => void
  className?: string
}) {
  const segments = React.useMemo(() => groupAdjacentActivities(items), [items])

  return (
    <div className={cn('my-2 w-full min-w-0', className)}>
      {showElapsedTime && (
        <div className="mb-2 border-b border-border/50 pb-2 text-xs text-muted-foreground">
          <ActivityElapsedTime
            isLive={isLive}
            isPaused={isPaused}
            startedAt={startedAt}
            durationMs={durationMs}
            pauseIntervals={pauseIntervals}
          />
        </div>
      )}
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          <MarkdownContent key={index} isStreaming={isLive && index === segments.length - 1}>
            {segment.text}
          </MarkdownContent>
        ) : (
          <ActivityDisclosure
            key={segment.items[0]!.id}
            items={segment.items}
            isLive={isLive && index === segments.length - 1}
            isPaused={isPaused}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        ),
      )}
    </div>
  )
}

function flattenActivities(item: ActivityItem): ActivityItem[] {
  return item.type === 'thinking' || item.type === 'narration'
    ? [item]
    : [item, ...(item.children ?? []).flatMap(flattenActivities)]
}

function ActivityDisclosure({
  items,
  isLive,
  isPaused,
  collapsed,
  onToggle,
}: {
  items: ActivityItem[]
  isLive: boolean
  isPaused: boolean
  collapsed: boolean
  onToggle?: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const [hasOpened, setHasOpened] = React.useState(false)
  const [childOpenMap, setChildOpenMap] = React.useState<Record<string, boolean>>({})
  const detailsId = React.useId()
  if (collapsed && open) {
    setOpen(false)
    setChildOpenMap({})
  }
  const meta = summarizeActivities(items)
  const activities = items.flatMap(flattenActivities)
  const completedSummary =
    items.length === 1 && items[0]!.type !== 'thinking' ? parseToolMeta(items[0]!).summary : meta.summary || '思考过程'
  const waitingForInput =
    isLive &&
    activities.some(
      (item) =>
        item.type !== 'thinking' &&
        item.type !== 'narration' &&
        item.name === 'request_user_input' &&
        item.status === 'running',
    )
  const IconComponent = activityIcons[meta.kind]
  const isWorking = isLive && !isPaused && !waitingForInput

  const toggle = () => {
    onToggle?.()
    if (!open) setHasOpened(true)
    else setChildOpenMap({})
    setOpen(!open)
  }
  const toggleChild = (id: string) => setChildOpenMap((previous) => ({ ...previous, [id]: !previous[id] }))

  return (
    <div className="min-w-0 py-1">
      <button
        type="button"
        aria-label={`活动详情：${completedSummary}`}
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={toggle}
        title={completedSummary}
        className="group/activity-toggle flex min-h-7 max-w-full items-center gap-2 rounded-sm py-0.5 pr-1 text-sm leading-5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
      >
        {!isPaused && (
          <span
            aria-hidden="true"
            className={cn(
              'inline-flex size-4 shrink-0',
              isWorking && 'text-primary animate-[thought-pulse_1.6s_ease-in-out_infinite]',
            )}
          >
            <IconComponent className="size-4" />
          </span>
        )}
        <span className={cn('min-w-0 truncate', isWorking && 'thought-shimmer')}>{completedSummary}</span>
        {waitingForInput && (
          <span role="status" className="shrink-0">
            等待你的回答…
          </span>
        )}
        <span
          aria-hidden="true"
          className={cn(
            'inline-flex size-3.5 shrink-0 opacity-0 transition-[opacity,transform] duration-200 group-hover/activity-toggle:opacity-100 group-focus-visible/activity-toggle:opacity-100',
            !open && '-rotate-90',
          )}
        >
          <ChevronDown className="size-3.5" />
        </span>
      </button>
      <div
        id={detailsId}
        aria-hidden={!open}
        inert={!open}
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {hasOpened && (
            <div
              aria-label="活动详情列表"
              className="mt-1 ml-2 max-h-[min(16rem,40dvh)] overflow-y-auto overscroll-y-contain border-l border-border/50 pl-3 pr-2 py-1 space-y-1 [&_pre]:max-h-none [&_pre]:overflow-visible [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]"
            >
              {items.map((item) =>
                item.type === 'thinking' ? (
                  <ThinkingActivityRow
                    key={item.id}
                    item={item}
                    open={Boolean(childOpenMap[item.id])}
                    onToggle={() => toggleChild(item.id)}
                    isPaused={isPaused}
                    isNested={false}
                    isLive={isLive}
                  />
                ) : item.type !== 'narration' ? (
                  <ToolActivityRow
                    key={item.id}
                    item={item}
                    open={Boolean(childOpenMap[item.id])}
                    onToggle={() => toggleChild(item.id)}
                    isLive={isLive}
                    isPaused={isPaused}
                    isNested={false}
                  />
                ) : null,
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function ActivityElapsedTime({
  isLive,
  isPaused,
  startedAt,
  durationMs,
  pauseIntervals,
}: {
  isLive: boolean
  isPaused: boolean
  startedAt?: number
  durationMs?: number
  pauseIntervals?: PiPauseInterval[]
}) {
  const [mountedAt] = React.useState(Date.now)
  const [now, setNow] = React.useState(Date.now)
  const start = startedAt ?? mountedAt

  React.useEffect(() => {
    if (!isLive || isPaused) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isLive, isPaused])

  const elapsedMs = activeDuration(
    start,
    isLive ? Math.max(now, Date.now()) : start + (durationMs ?? 0),
    pauseIntervals,
  )
  const duration = formatDurationChinese(elapsedMs)
  if (duration) return <>用时 {duration}</>
  if (isLive) return <>{isPaused ? '已暂停' : '处理中'}</>
  return <>{durationMs === undefined ? '已结束' : '用时不足1秒'}</>
}

/** 兼容旧名称 ActionGroup */
export const ActionGroup = ActivityGroup
