import { SidebarMoreMenu, SidebarRowMenu } from './sidebar-menus'
import { GitFork, Loader2, MessageSquare, Pin, PinOff } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'
import type { PiSessionSummary } from '@pi-meme/contracts/sessions'
import { formatSessionTitle } from './session-title'
import type { SidebarDragProps } from './sidebar-controls'
import { SidebarSourceBadge, type SidebarSource } from './sidebar-source'

/** 分叉会话的来源标识：头部 parentSession 来自 SDK 会话元数据。同时显示创建时间，区分同名分支。 */
function ForkBadge({ session }: { session: PiSessionSummary }) {
  if (!session.parentSessionPath) return null
  const time = formatForkTime(session.created)
  return (
    <span
      title={`分叉自：${session.parentSessionPath}`}
      className="inline-flex shrink-0 items-center gap-0.5 text-[0.625rem] text-primary/70"
    >
      <GitFork aria-label="分叉自其他会话" className="size-3 text-primary/80" />
      {time && <span className="tabular-nums">{time}</span>}
    </span>
  )
}

/** 取创建时间的时:分作为分叉会话的短后缀。 */
function formatForkTime(created: string): string {
  try {
    const date = new Date(created)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

export function SessionItem({
  session,
  projectName,
  variant,
  isActive,
  isPinned = false,
  dragProps,
  source,
  onSwitchSession,
  onTogglePin,
  onPrefetchSession,
}: {
  session: PiSessionSummary
  projectName?: string
  variant: 'pinned' | 'project' | 'recent'
  isActive: boolean
  isPinned?: boolean
  dragProps?: SidebarDragProps
  source?: SidebarSource
  onSwitchSession: (path: string) => void
  onTogglePin?: (path: string) => void
  onPrefetchSession?: (path: string) => void
}) {
  const handleMouseEnter = () => {
    if (!isActive) onPrefetchSession?.(session.path)
  }
  const isRunning = session.running && !session.isPaused && (!source || source.connected)
  const runningIndicator = isRunning ? (
    <span className="inline-flex shrink-0 animate-spin text-muted-foreground group-hover:hidden group-has-[:focus-visible]:hidden group-has-[[data-state=open]]:hidden">
      <Loader2 aria-label="会话运行中" className="size-3.5" />
    </span>
  ) : null

  if (variant === 'pinned') {
    return (
      <SidebarRowMenu target={{ kind: 'session', session }}>
        <div
          {...dragProps}
          onMouseEnter={handleMouseEnter}
          className={cn(
            'group relative flex w-full min-w-0 items-center justify-between rounded-lg pr-2.5 text-xs transition-colors duration-200 ease-out cursor-pointer',
            isActive ? 'bg-secondary/70 font-medium text-foreground' : 'text-foreground/90 hover:text-foreground',
            dragProps?.draggable && 'cursor-grab active:cursor-grabbing',
          )}
          data-session-path={session.path}
          title={`${formatSessionTitle(session)}\n所属项目：${projectName ?? '无项目'}`}
        >
          <button
            type="button"
            aria-current={isActive ? 'true' : undefined}
            onClick={() => {
              if (!isActive) onSwitchSession(session.path)
            }}
            onFocus={handleMouseEnter}
            className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden pl-2 py-2 text-left rounded cursor-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MessageSquare aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate min-w-0">{formatSessionTitle(session)}</span>
            <ForkBadge session={session} />
          </button>
          <div
            data-sidebar-drag-ignore
            draggable={false}
            className={cn('flex items-center gap-1 shrink-0 ml-1', isRunning && '[&_button]:transition-none')}
          >
            <button
              type="button"
              aria-label={`取消置顶：${formatSessionTitle(session)}`}
              disabled={Boolean(source?.disabledReason)}
              onClick={(e) => {
                e.stopPropagation()
                onTogglePin?.(session.path)
              }}
              className="opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring text-muted-foreground hover:text-foreground transition-opacity p-1 shrink-0"
            >
              <PinOff className="size-3" />
            </button>
            <span className="grid size-5 shrink-0 place-items-center [&>*]:[grid-area:1/1]">
              <SidebarMoreMenu target={{ kind: 'session', session }} />
              {runningIndicator}
            </span>
            {source && <SidebarSourceBadge source={source} />}
          </div>
        </div>
      </SidebarRowMenu>
    )
  }
  if (variant === 'project') {
    return (
      <SidebarRowMenu target={{ kind: 'session', session }}>
        <div
          onMouseEnter={handleMouseEnter}
          className={cn(
            'group relative flex w-full min-w-0 items-center justify-between rounded-lg pr-2 text-xs transition-colors duration-200 ease-out cursor-pointer',
            isActive ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
          data-session-path={session.path}
          title={formatSessionTitle(session)}
        >
          <button
            type="button"
            aria-current={isActive ? 'true' : undefined}
            onClick={() => {
              if (!isActive) onSwitchSession(session.path)
            }}
            onFocus={handleMouseEnter}
            className="flex min-w-0 flex-1 items-center gap-1 pl-2.5 pr-1.5 py-1.5 text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate min-w-0">{formatSessionTitle(session)}</span>
            <ForkBadge session={session} />
          </button>
          <div className={cn('flex items-center gap-1 shrink-0', isRunning && '[&_button]:transition-none')}>
            <button
              type="button"
              disabled={Boolean(source?.disabledReason)}
              title={source?.disabledReason || (isPinned ? '取消置顶会话' : '置顶会话')}
              aria-label={`${isPinned ? '取消置顶会话' : '置顶会话'}：${formatSessionTitle(session)}`}
              onClick={(e) => {
                e.stopPropagation()
                onTogglePin?.(session.path)
              }}
              className={cn(
                'transition-opacity p-0.5 hover:text-foreground cursor-pointer rounded opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isPinned ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <Pin className="size-3" />
            </button>
            <span className="grid size-5 shrink-0 place-items-center [&>*]:[grid-area:1/1]">
              <SidebarMoreMenu target={{ kind: 'session', session }} />
              {runningIndicator}
            </span>
            {source && <SidebarSourceBadge source={source} />}
          </div>
        </div>
      </SidebarRowMenu>
    )
  }
  return (
    <SidebarRowMenu target={{ kind: 'session', session }}>
      <div
        onMouseEnter={handleMouseEnter}
        className={cn(
          'group relative flex w-full min-w-0 items-center justify-between rounded-lg pr-2.5 text-xs transition-colors duration-200 ease-out cursor-pointer',
          isActive ? 'font-medium text-foreground' : 'text-foreground/85 hover:text-foreground',
        )}
        data-session-path={session.path}
        title={formatSessionTitle(session)}
      >
        <button
          type="button"
          aria-current={isActive ? 'true' : undefined}
          onClick={() => {
            if (!isActive) onSwitchSession(session.path)
          }}
          onFocus={handleMouseEnter}
          className="flex min-w-0 flex-1 items-center gap-1 pl-2.5 pr-1.5 py-1.5 text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate min-w-0">{formatSessionTitle(session)}</span>
          <ForkBadge session={session} />
        </button>
        <div className={cn('flex items-center gap-1 shrink-0', isRunning && '[&_button]:transition-none')}>
          <button
            type="button"
            aria-label={`${isPinned ? '取消置顶会话' : '置顶会话'}：${formatSessionTitle(session)}`}
            disabled={Boolean(source?.disabledReason)}
            onClick={(e) => {
              e.stopPropagation()
              onTogglePin?.(session.path)
            }}
            className={cn(
              'transition-opacity p-0.5 hover:text-foreground cursor-pointer rounded opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isPinned ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <Pin className="size-3" />
          </button>
          <span className="grid size-5 shrink-0 place-items-center [&>*]:[grid-area:1/1]">
            <SidebarMoreMenu target={{ kind: 'session', session }} />
            {runningIndicator}
          </span>
          {source && <SidebarSourceBadge source={source} />}
        </div>
      </div>
    </SidebarRowMenu>
  )
}
