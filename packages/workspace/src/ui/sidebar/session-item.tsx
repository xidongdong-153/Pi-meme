import { SidebarRowMenu } from './sidebar-menus'
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
            'group relative flex w-full min-w-0 items-center justify-between rounded-lg px-2 py-1 text-xs transition-colors duration-150 ease-out cursor-pointer',
            isActive
              ? 'bg-secondary/50 font-medium text-foreground'
              : 'text-foreground/90 hover:bg-secondary/30 hover:text-foreground',
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
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden py-0.5 pr-1 text-left rounded cursor-[inherit] transition-[padding] duration-150 ease-out group-hover:pr-7 group-has-[:focus-visible]:pr-7 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <MessageSquare aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span
              className={cn(
                'min-w-0 truncate transition-[mask-image] duration-150',
                'group-hover:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent_100%)] group-hover:[-webkit-mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent_100%)]',
                'group-has-[:focus-visible]:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent_100%)] group-has-[:focus-visible]:[-webkit-mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent_100%)]',
              )}
            >
              {formatSessionTitle(session)}
            </span>
            <ForkBadge session={session} />
          </button>
          <div className="flex items-center gap-1 shrink-0 ml-1">
            {source && (
              <span className="transition-opacity group-hover:opacity-0 group-has-[:focus-visible]:opacity-0">
                <SidebarSourceBadge source={source} />
              </span>
            )}
            {runningIndicator}
          </div>
          <div
            data-sidebar-drag-ignore
            draggable={false}
            className={cn(
              'absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 rounded',
              'opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 group-has-[[data-state=open]]:opacity-100',
              'pointer-events-none group-hover:pointer-events-auto group-has-[:focus-visible]:pointer-events-auto group-has-[[data-state=open]]:pointer-events-auto',
              'transition-opacity duration-150 ease-out',
              isRunning && '[&_button]:transition-none',
            )}
          >
            <button
              type="button"
              aria-label={`取消置顶：${formatSessionTitle(session)}`}
              disabled={Boolean(source?.disabledReason)}
              onClick={(e) => {
                e.stopPropagation()
                onTogglePin?.(session.path)
              }}
              className="p-1 hover:text-foreground text-muted-foreground cursor-pointer rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring shrink-0"
            >
              <PinOff className="size-3" />
            </button>
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
            'group relative flex w-full min-w-0 items-center justify-between rounded-lg px-2 py-1 text-xs transition-colors duration-150 ease-out cursor-pointer',
            isActive
              ? 'bg-secondary/50 font-medium text-foreground'
              : 'text-muted-foreground hover:bg-secondary/30 hover:text-foreground',
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
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden py-0.5 pr-1 text-left rounded transition-[padding] duration-150 ease-out group-hover:pr-7 group-has-[:focus-visible]:pr-7 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span
              className={cn(
                'min-w-0 truncate transition-[mask-image] duration-150',
                'group-hover:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent_100%)] group-hover:[-webkit-mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent_100%)]',
                'group-has-[:focus-visible]:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent_100%)] group-has-[:focus-visible]:[-webkit-mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent_100%)]',
              )}
            >
              {formatSessionTitle(session)}
            </span>
            <ForkBadge session={session} />
          </button>
          {runningIndicator}
          <div
            data-sidebar-drag-ignore
            draggable={false}
            className={cn(
              'absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 rounded',
              'opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 group-has-[[data-state=open]]:opacity-100',
              'pointer-events-none group-hover:pointer-events-auto group-has-[:focus-visible]:pointer-events-auto group-has-[[data-state=open]]:pointer-events-auto',
              'transition-opacity duration-150 ease-out',
              isRunning && '[&_button]:transition-none',
            )}
          >
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
                'p-1 hover:text-foreground cursor-pointer rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                isPinned ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <Pin className="size-3" />
            </button>
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
          'group relative flex w-full min-w-0 items-center justify-between rounded-lg px-2 py-1 text-xs transition-colors duration-150 ease-out cursor-pointer',
          isActive
            ? 'bg-secondary/50 font-medium text-foreground'
            : 'text-foreground/85 hover:bg-secondary/30 hover:text-foreground',
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
          className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden py-0.5 pr-1 text-left rounded transition-[padding] duration-150 ease-out group-hover:pr-7 group-has-[:focus-visible]:pr-7 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span
            className={cn(
              'min-w-0 truncate transition-[mask-image] duration-150',
              'group-hover:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent_100%)] group-hover:[-webkit-mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent_100%)]',
              'group-has-[:focus-visible]:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent_100%)] group-has-[:focus-visible]:[-webkit-mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent_100%)]',
            )}
          >
            {formatSessionTitle(session)}
          </span>
          <ForkBadge session={session} />
        </button>
        <div className="flex items-center gap-1 shrink-0 ml-1">
          {source && (
            <span className="transition-opacity group-hover:opacity-0 group-has-[:focus-visible]:opacity-0">
              <SidebarSourceBadge source={source} />
            </span>
          )}
          {runningIndicator}
        </div>
        <div
          data-sidebar-drag-ignore
          draggable={false}
          className={cn(
            'absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 rounded',
            'opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 group-has-[[data-state=open]]:opacity-100',
            'pointer-events-none group-hover:pointer-events-auto group-has-[:focus-visible]:pointer-events-auto group-has-[[data-state=open]]:pointer-events-auto',
            'transition-opacity duration-150 ease-out',
            isRunning && '[&_button]:transition-none',
          )}
        >
          <button
            type="button"
            aria-label={`${isPinned ? '取消置顶会话' : '置顶会话'}：${formatSessionTitle(session)}`}
            disabled={Boolean(source?.disabledReason)}
            onClick={(e) => {
              e.stopPropagation()
              onTogglePin?.(session.path)
            }}
            className={cn(
              'p-1 hover:text-foreground cursor-pointer rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              isPinned ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <Pin className="size-3" />
          </button>
        </div>
      </div>
    </SidebarRowMenu>
  )
}
