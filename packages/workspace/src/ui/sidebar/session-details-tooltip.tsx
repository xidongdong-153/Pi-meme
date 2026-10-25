import type { ReactNode } from 'react'
import { Clock, Globe, Laptop, MessageCircle } from 'lucide-react'
import type { PiSessionSummary } from '@pi-meme/contracts/sessions'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { SidebarRowMenu } from './sidebar-menus'
import type { SidebarSource } from './sidebar-source'
import { formatSessionTitle } from './session-title'

function activityTime(value: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`
  if (minutes < 43200) return `${Math.floor(minutes / 1440)} 天前`
  return new Date(timestamp).toLocaleDateString('zh-CN')
}

function nextRunText(task: NonNullable<PiSessionSummary['scheduledTask']>) {
  if (task.status === 'paused') return '定时任务已暂停'
  if (task.status === 'completed') return '定时任务已结束'
  if (!task.nextRunAt) return '暂无后续安排'
  try {
    const next = new Date(task.nextRunAt)
    const parts = (date: Date) =>
      Object.fromEntries(
        new Intl.DateTimeFormat('zh-CN', {
          timeZone: task.timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        })
          .formatToParts(date)
          .map((part) => [part.type, part.value]),
      )
    const target = parts(next)
    const today = parts(new Date())
    const day = (value: typeof target) => Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day))
    const difference = (day(target) - day(today)) / 86400000
    const date =
      difference === 0
        ? '今天'
        : difference === 1
          ? '明天'
          : `${target.year === today.year ? '' : `${target.year} 年 `}${Number(target.month)} 月 ${Number(target.day)} 日`
    const zone = task.timeZone === new Intl.DateTimeFormat().resolvedOptions().timeZone ? '' : ` · ${task.timeZone}`
    return `下次运行：${date} ${target.hour}:${target.minute}${zone}`
  } catch {
    return '运行时间不可用'
  }
}

export function SessionDetailsTooltip({
  session,
  source,
  projectName,
  children,
}: {
  session: PiSessionSummary
  source?: SidebarSource
  projectName?: string
  children: ReactNode
}) {
  const title = formatSessionTitle(session)
  const activity = session.completedAt ?? session.modified
  const running = session.running && !session.isPaused && (!source || source.connected)
  return (
    <Tooltip delayDuration={350} disableHoverableContent>
      <SidebarRowMenu target={{ kind: 'session', session }}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
      </SidebarRowMenu>
      <TooltipContent
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="w-80 max-w-[calc(100vw-24px)] rounded-xl px-3 py-2.5 text-xs shadow-lg"
      >
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 break-words text-sm font-medium leading-5">{title}</span>
          <span
            role="img"
            aria-label={source ? `远程：${source.label}` : '本机'}
            className="mt-1 shrink-0 text-muted-foreground"
          >
            {source ? (
              <Globe aria-hidden="true" className="size-3.5" />
            ) : (
              <Laptop aria-hidden="true" className="size-3.5" />
            )}
          </span>
          <time dateTime={activity} className="ml-2 shrink-0 leading-5 text-muted-foreground">
            {running ? '运行中' : activityTime(activity)}
          </time>
        </div>
        <div className="mt-2 flex items-center gap-2 leading-5">
          <MessageCircle aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span>聊天</span>
          {(source || projectName) && (
            <span className="min-w-0 truncate text-muted-foreground">
              · {source?.label ?? projectName}
              {source && !source.connected ? ' · 未连接' : ''}
            </span>
          )}
        </div>
        {session.scheduledTask && (
          <div className="mt-1 flex items-start gap-2 leading-5">
            <Clock aria-hidden="true" className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 break-words">
              {source && !source.connected ? '远程未连接，安排待同步' : nextRunText(session.scheduledTask)}
            </span>
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
