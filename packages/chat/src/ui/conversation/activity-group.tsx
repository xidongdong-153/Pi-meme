import * as React from 'react'
import type { PiPauseInterval } from '@pi-meme/contracts/pi'
import { activeDuration } from '../model/active-duration'
import type { ActivityItem } from '../model/types'
import { cn } from '@pi-meme/ui/lib/utils'
import { BookOpen, ChevronDown, Images, Pencil, Search, SquareTerminal, Wrench } from 'lucide-react'
import { groupAdjacentActivities, summarizeActivities, formatDurationChinese } from '../model/activity-summary'
import { ThinkingActivityRow } from './thinking-activity-row'
import { ToolActivityRow } from './tool-activity-row'
import { NarrationActivityRow } from './narration-activity-row'

export function ActivityGroup({
  items,
  isLive = false,
  isPaused = false,
  pauseIntervals,
  durationMs,
  startedAt,
  className,
}: {
  items: ActivityItem[]
  isLive?: boolean
  isPaused?: boolean
  pauseIntervals?: PiPauseInterval[]
  durationMs?: number
  startedAt?: number
  className?: string
}) {
  const [disclosure, setDisclosure] = React.useState({ isLive, open: isLive })
  if (disclosure.isLive !== isLive) {
    setDisclosure({ isLive, open: isLive })
  }
  const groupOpen = disclosure.open
  const [childOpenMap, setChildOpenMap] = React.useState<Record<string, boolean>>({})
  const [mountedAt] = React.useState(Date.now)
  const activityGroups = React.useMemo(() => groupAdjacentActivities(items), [items])

  const toggleChild = React.useCallback((id: string) => {
    setChildOpenMap((previous) => ({ ...previous, [id]: !previous[id] }))
  }, [])

  const canExpand = items.length > 0
  const elapsedTime = (
    <ActivityElapsedTime
      isLive={isLive}
      isPaused={isPaused}
      startedAt={startedAt ?? mountedAt}
      durationMs={durationMs}
      pauseIntervals={pauseIntervals}
    />
  )

  return (
    <div className={cn('my-2 w-full', className)}>
      <div className="border-b border-border/50 pb-2">
        {canExpand ? (
          <button
            type="button"
            aria-label="工作过程"
            aria-expanded={groupOpen}
            onClick={() => setDisclosure({ isLive, open: !groupOpen })}
            className="inline-flex min-h-6 items-center gap-1.5 rounded-sm py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
          >
            <span>{elapsedTime}</span>
            <ChevronDown
              className={cn('size-3.5 shrink-0 transition-transform duration-300 ease-out', !groupOpen && '-rotate-90')}
            />
          </button>
        ) : (
          <div role="status" className="inline-flex min-h-6 items-center py-0.5 text-xs text-muted-foreground">
            {elapsedTime}
          </div>
        )}
      </div>

      {canExpand && (
        <div
          aria-label="工作过程详情"
          aria-hidden={!groupOpen}
          inert={!groupOpen}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-300 ease-out',
            groupOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="space-y-1 pt-2 pb-1">
              {activityGroups.map((group) => {
                if (group.type === 'item') {
                  const item = group.item
                  if (item.type === 'narration') return <NarrationActivityRow key={item.id} item={item} />
                  return (
                    <ThinkingActivityRow
                      key={item.id}
                      item={item}
                      open={Boolean(childOpenMap[item.id])}
                      onToggle={() => toggleChild(item.id)}
                      isPaused={isPaused}
                      isNested={false}
                    />
                  )
                }
                const first = group.items[0]!
                if (group.items.length === 1) {
                  return (
                    <ToolActivityRow
                      key={first.id}
                      item={first}
                      open={Boolean(childOpenMap[first.id])}
                      onToggle={() => toggleChild(first.id)}
                      isLive={isLive}
                      isPaused={isPaused}
                      isNested={false}
                    />
                  )
                }
                const groupId = `tools-${first.id}`
                const open = Boolean(childOpenMap[groupId])
                const meta = summarizeActivities(group.items)
                const IconComponent = {
                  command: SquareTerminal,
                  read: BookOpen,
                  write: Pencil,
                  edit: Pencil,
                  image: Images,
                  search: Search,
                  generic: Wrench,
                  thinking: Wrench,
                }[meta.kind]
                const hasError = group.items.some((item) => item.status === 'error')
                return (
                  <div key={groupId}>
                    <button
                      type="button"
                      aria-label="工具调用组"
                      aria-expanded={open}
                      onClick={() => toggleChild(groupId)}
                      className={cn(
                        'flex min-h-6 max-w-full items-center gap-2 rounded-sm py-0.5 text-sm leading-5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      )}
                    >
                      <IconComponent className="size-4 shrink-0" />
                      <span className={cn('truncate', hasError && 'text-destructive')}>{meta.summary}</span>
                      {hasError && <span className="shrink-0 text-destructive">有调用失败</span>}
                      <ChevronDown
                        className={cn(
                          'size-3.5 shrink-0 transition-transform duration-300 ease-out',
                          !open && '-rotate-90',
                        )}
                      />
                    </button>
                    <div
                      aria-hidden={!open}
                      inert={!open}
                      className={cn(
                        'grid transition-[grid-template-rows,opacity] duration-300 ease-out',
                        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
                      )}
                    >
                      <div className="min-h-0 overflow-hidden">
                        <div className="space-y-1 pt-1 pl-6">
                          {group.items.map((item) => (
                            <ToolActivityRow
                              key={item.id}
                              item={item}
                              open={Boolean(childOpenMap[item.id])}
                              onToggle={() => toggleChild(item.id)}
                              isLive={isLive}
                              isPaused={isPaused}
                              isNested={false}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ActivityElapsedTime({
  isLive,
  isPaused,
  startedAt,
  durationMs,
  pauseIntervals,
}: {
  isLive: boolean
  isPaused: boolean
  startedAt: number
  durationMs?: number
  pauseIntervals?: PiPauseInterval[]
}) {
  const [now, setNow] = React.useState(Date.now)

  React.useEffect(() => {
    if (!isLive || isPaused) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isLive, isPaused])

  const elapsedMs = activeDuration(
    startedAt,
    isLive ? Math.max(now, Date.now()) : startedAt + (durationMs ?? 0),
    pauseIntervals,
  )
  const duration = formatDurationChinese(elapsedMs)
  if (duration) return <>用时 {duration}</>
  if (isLive) return <>{isPaused ? '已暂停' : '处理中'}</>
  return <>{durationMs === undefined ? '已结束' : '用时不足1秒'}</>
}

/** 兼容旧名称 ActionGroup */
export const ActionGroup = ActivityGroup
