import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import * as React from 'react'
import type { PiPauseInterval } from '@pi-meme/contracts/pi'
import { activeDuration } from '../model/active-duration'
import type { ActivityItem } from '../model/types'
import { cn } from '@pi-meme/ui/lib/utils'
import { BookOpen, ChevronDown, Images, Pencil, Search, Sparkles, SquareTerminal, Wrench } from 'lucide-react'
import { groupAdjacentActivities, summarizeActivities, formatDurationChinese } from '../model/activity-summary'
import { MarkdownContent } from '../content/markdown-content'
import { ThinkingActivityRow } from './thinking-activity-row'
import { ToolActivityRow } from './tool-activity-row'
import { PluginMessageActionsGroup } from '@pi-meme/ui/components/plugin-message-actions'
import { toolMessageActionAnchor } from '../model/tool-message-action-anchor'
import { RetainedDisclosure, usePresentationActive } from './retained-disclosure'

const activityIcons = {
  command: SquareTerminal,
  read: BookOpen,
  write: Pencil,
  edit: Pencil,
  image: Images,
  'image-generation': Images,
  search: Search,
  generic: Wrench,
  thinking: Sparkles,
}

const ActivityDisclosure = React.memo(ActivityDisclosureContent)
const ActivityRow = React.memo(ActivityRowContent)
export const ActivityGroup = React.memo(ActivityGroupContent)

function ActivityGroupContent({
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

function ActivityDisclosureContent({
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
  const meta = React.useMemo(() => summarizeActivities(items, isLive, isPaused), [items, isLive, isPaused])
  const waitingForInput = meta.status === 'waiting'
  const toolAnchors = React.useMemo(
    () =>
      items.flatMap((item) => {
        const anchor = toolMessageActionAnchor(item)
        return anchor ? [anchor] : []
      }),
    [items],
  )
  const IconComponent = activityIcons[meta.kind]
  // 工具交接期间保持扫光连续，避免每次收到结果都停止并重启动画。
  const isWorking = isLive && !isPaused && (meta.status === 'running' || meta.status === 'complete')

  const toggle = () => {
    onToggle?.()
    if (!open) setHasOpened(true)
    else setChildOpenMap({})
    setOpen(!open)
  }
  const toggleChild = React.useCallback(
    (id: string) => setChildOpenMap((previous) => ({ ...previous, [id]: !previous[id] })),
    [],
  )

  return (
    <div className="min-w-0 py-1">
      <div className="flex min-w-0 items-center gap-1">
        <TooltipHint content={meta.summary}>
          <button
            type="button"
            aria-label={`活动详情：${meta.summary}`}
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={toggle}

            className="group/activity-toggle flex min-h-7 max-w-full items-center gap-2 rounded-sm py-0.5 pr-1 text-xs leading-5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
          >
            <span aria-hidden="true" className="inline-flex size-4 shrink-0">
              <IconComponent className="size-4" />
            </span>
            <span
              role={waitingForInput ? 'status' : undefined}
              className={cn('min-w-0 truncate', isWorking && 'thought-shimmer')}
            >
              {meta.summary}
            </span>
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex size-3.5 shrink-0 opacity-0 transition-[opacity,rotate] duration-200 ease-out motion-reduce:transition-none group-hover/activity-toggle:opacity-100 group-focus-visible/activity-toggle:opacity-100',
                !open && '-rotate-90',
              )}
            >
              <ChevronDown className="size-3.5" />
            </span>
          </button>
        </TooltipHint>
        <PluginMessageActionsGroup anchors={toolAnchors} />
      </div>
      <RetainedDisclosure
        open={open}
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
            <ActivityDetails>
              {items.map((item) =>
                item.type !== 'narration' ? (
                  <ActivityRow
                    key={item.id}
                    item={item}
                    open={Boolean(childOpenMap[item.id])}
                    onToggle={toggleChild}
                    isPaused={isPaused}
                    isLive={isLive}
                  />
                ) : null,
              )}
            </ActivityDetails>
          )}
        </div>
      </RetainedDisclosure>
    </div>
  )
}

function ActivityDetails({ children }: { children: React.ReactNode }) {
  const active = usePresentationActive()
  const [hasOverflowAbove, setHasOverflowAbove] = React.useState(false)
  const [hasOverflowBelow, setHasOverflowBelow] = React.useState(false)
  const detailsRef = React.useRef<HTMLDivElement>(null)
  const detailsContentRef = React.useRef<HTMLDivElement>(null)

  React.useLayoutEffect(() => {
    const element = detailsRef.current
    const content = detailsContentRef.current
    if (!active || !element || !content) return
    const measure = () => {
      setHasOverflowAbove(element.scrollTop > 1)
      setHasOverflowBelow(element.scrollHeight - element.clientHeight - element.scrollTop > 1)
    }
    measure()
    element.addEventListener('scroll', measure, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    observer?.observe(content)
    return () => {
      element.removeEventListener('scroll', measure)
      observer?.disconnect()
    }
  }, [active])

  return (
    <div
      ref={detailsRef}
      aria-label="活动详情列表"
      data-overflow-top={hasOverflowAbove}
      data-overflow-bottom={hasOverflowBelow}
      className="scroll-fade mt-1 max-h-[min(16rem,40dvh)] overflow-y-auto overscroll-y-contain pr-2 py-1 [&_pre]:max-h-none [&_pre]:overflow-visible [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]"
    >
      <div ref={detailsContentRef} className="space-y-1">
        {children}
      </div>
    </div>
  )
}

function ActivityRowContent({
  item,
  open,
  onToggle,
  isPaused,
  isLive,
}: {
  item: Exclude<ActivityItem, { type: 'narration' }>
  open: boolean
  onToggle: (id: string) => void
  isPaused: boolean
  isLive: boolean
}) {
  const toggle = React.useCallback(() => onToggle(item.id), [onToggle, item.id])
  return item.type === 'thinking' ? (
    <ThinkingActivityRow item={item} open={open} onToggle={toggle} isPaused={isPaused} isLive={isLive} />
  ) : (
    <ToolActivityRow item={item} open={open} onToggle={toggle} isPaused={isPaused} isLive={isLive} actions={null} />
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
