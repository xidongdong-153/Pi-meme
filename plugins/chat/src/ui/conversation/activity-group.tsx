import * as React from 'react'
import type { ActivityItem } from '../model/types'
import { cn } from '@pi-meme/ui/lib/utils'
import { BookOpen, ChevronDown, Images, Loader2, Pencil, Search, Sparkles, SquareTerminal, Wrench } from 'lucide-react'
import { summarizeActivities, formatDurationChinese } from '../model/activity-summary'
import { ThinkingActivityRow } from './thinking-activity-row'
import { ToolActivityRow } from './tool-activity-row'
import { NarrationActivityRow } from './narration-activity-row'

export function ActivityGroup({
  items,
  isLive = false,
  durationMs,
  startedAt,
  className,
}: {
  items: ActivityItem[]
  isLive?: boolean
  durationMs?: number
  startedAt?: number
  className?: string
}) {
  const hasRunning = items.some((i) => i.status === 'running') || isLive
  const [groupOpen, setGroupOpen] = React.useState(false)
  const [childOpenMap, setChildOpenMap] = React.useState<Record<string, boolean>>({})
  const [now, setNow] = React.useState(Date.now)
  const [mountedAt] = React.useState(Date.now)

  React.useEffect(() => {
    if (!hasRunning) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasRunning])

  const toggleChild = React.useCallback((id: string) => {
    setChildOpenMap((prev) => ({
      ...prev,
      [id]: !prev[id],
    }))
  }, [])

  const groupMeta = summarizeActivities(items)
  const IconComponent = {
    command: SquareTerminal,
    read: BookOpen,
    write: Pencil,
    edit: Pencil,
    image: Images,
    search: Search,
    generic: Wrench,
    thinking: Sparkles,
  }[groupMeta.kind]
  const elapsedMs = hasRunning ? Math.max(0, now - (startedAt ?? mountedAt)) : durationMs
  const durationText = formatDurationChinese(elapsedMs ?? 0) || '0秒'
  const summaryTitle = hasRunning
    ? `工作了 ${durationText}`
    : [`工作了 ${durationText}`, groupMeta.summary].filter(Boolean).join(' · ')

  if (items.length === 0) return null

  return (
    <div className={cn('my-1.5 select-none', className)}>
      {/* 组标题栏 */}
      <div
        role="button"
        aria-label="工作过程"
        aria-expanded={groupOpen}
        tabIndex={0}
        onClick={() => {
          setGroupOpen(!groupOpen)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setGroupOpen(!groupOpen)
          }
        }}
        className={cn(
          'group flex w-full items-center justify-between py-1 px-1 -mx-1 rounded cursor-pointer transition-colors',
          'text-muted-foreground hover:text-foreground hover:bg-secondary/30 text-xs',
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground/80 transition-transform duration-200',
              groupOpen ? 'rotate-0' : '-rotate-90',
            )}
          />
          {hasRunning ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
          ) : (
            <IconComponent className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
          )}
          <span className="truncate font-medium">{summaryTitle}</span>
        </div>
      </div>

      {/* 展开的内聚子项列表 */}
      {groupOpen && (
        <div
          aria-label="工作过程详情"
          className="max-h-80 overflow-y-auto overscroll-contain pl-3.5 pr-2 border-l border-border/40 mt-1 space-y-0.5"
        >
          {items.map((item, idx) => {
            const key = item.id || `act-${idx}`
            const isOpen = Boolean(childOpenMap[item.id])
            if (item.type === 'thinking') {
              return (
                <ThinkingActivityRow
                  key={key}
                  item={item}
                  open={isOpen}
                  onToggle={() => toggleChild(item.id)}
                  isNested
                />
              )
            }
            if (item.type === 'narration') {
              return <NarrationActivityRow key={key} item={item} isNested />
            }
            return (
              <ToolActivityRow key={key} item={item} open={isOpen} onToggle={() => toggleChild(item.id)} isNested />
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 兼容旧名称 ActionGroup */
export const ActionGroup = ActivityGroup
