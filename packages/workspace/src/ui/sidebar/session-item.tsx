import { useEffect, useRef } from 'react'
import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { Clock, Folder, GitFork, Globe, Laptop, Loader2, MessageCircle, Pin, PinOff } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'
import type { PiSessionSummary } from '@pi-meme/contracts/sessions'
import { formatSessionTitle } from './session-title'
import { SidebarTitle } from './sidebar-title'
import type { SidebarDragProps } from './sidebar-controls'
import type { SidebarSource } from './sidebar-source'
import { SidebarMoreMenu, SidebarRowMenu, type MenuTarget } from './sidebar-menus'
import { SidebarHoverCard } from './sidebar-hover-card'
import { activityTime } from './session-details'

/** 分叉会话的简短标识；父会话路径在会话详情中查看。 */
function ForkBadge({ session }: { session: PiSessionSummary }) {
  if (!session.parentSessionPath) return null
  const date = new Date(session.created)
  const time = Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <TooltipHint content="分叉会话">
      <span className="inline-flex shrink-0 items-center gap-0.5 text-[0.625rem] text-primary/70">
        <GitFork aria-label="分叉自其他会话" className="size-3 text-primary/80" />
        {time && <span className="tabular-nums">{time}</span>}
      </span>
    </TooltipHint>
  )
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
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancelPrefetch = () => {
    if (prefetchTimer.current !== undefined) clearTimeout(prefetchTimer.current)
    prefetchTimer.current = undefined
  }
  useEffect(() => cancelPrefetch, [session.path, isActive])
  const handleMouseEnter = () => {
    cancelPrefetch()
    if (!isActive) prefetchTimer.current = setTimeout(() => onPrefetchSession?.(session.path), 120)
  }
  const needsInput = (session.inputUnread ?? session.needsInput) && (!source || source.connected)
  const isRunning = session.running && !session.isPaused && !session.needsInput && (!source || source.connected)
  const title = formatSessionTitle(session)
  const target: MenuTarget = { kind: 'session', session, source, projectName }
  const pinned = variant === 'pinned' || isPinned

  const activity = session.completedAt ?? session.modified
  const fullTitle = formatSessionTitle(session, { full: true })
  const project =
    session.workspaceKind === 'standalone'
      ? '无项目'
      : projectName || (session.sourceProjectCwd ?? session.cwd).split(/[\\/]/).filter(Boolean).at(-1) || '无项目'

  return (
    <SidebarHoverCard
      label={`会话预览：${fullTitle}`}
      content={() => (
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <h3 className="min-w-0 flex-1 font-semibold text-foreground [overflow-wrap:anywhere]">
              {fullTitle}
              {source ? (
                <Globe
                  aria-label={`远程：${source.label}`}
                  className="ml-1.5 inline-block size-3 align-baseline text-muted-foreground"
                />
              ) : (
                <Laptop aria-label="本机" className="ml-1.5 inline-block size-3 align-baseline text-muted-foreground" />
              )}
            </h3>
            <time dateTime={activity} className="shrink-0 pt-px text-[11px] text-muted-foreground">
              {activityTime(activity) || '时间不可用'}
            </time>
          </div>
          <div className="flex items-start gap-2 text-foreground/90">
            <Folder aria-hidden="true" className="mt-px size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{project}</span>
          </div>
          {source && (
            <p className="whitespace-pre-line text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
              {source.description}
            </p>
          )}
        </div>
      )}
    >
      <SidebarRowMenu target={target}>
        <div
          {...(variant === 'pinned' ? dragProps : undefined)}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={cancelPrefetch}
          className={cn(
            'group relative flex w-full min-w-0 items-center justify-between rounded-lg px-2 py-1 text-xs transition-colors duration-150 ease-out cursor-pointer',
            isActive
              ? 'bg-secondary/50 font-medium text-foreground'
              : variant === 'project'
                ? 'text-muted-foreground hover:bg-secondary/30 hover:text-foreground'
                : 'text-foreground/85 hover:bg-secondary/30 hover:text-foreground',
            variant === 'pinned' && dragProps?.draggable && 'cursor-grab active:cursor-grabbing',
          )}
          data-session-path={session.path}
        >
          <button
            type="button"
            aria-current={isActive ? 'true' : undefined}
            onClick={() => onSwitchSession(session.path)}
            onFocus={handleMouseEnter}
            onBlur={cancelPrefetch}
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden py-0.5 pr-1 text-left rounded cursor-[inherit] transition-[padding] duration-150 ease-out group-hover:pr-14 group-has-[:focus-visible]:pr-14 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {variant === 'pinned' && (
              <MessageCircle aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <SidebarTitle>{title}</SidebarTitle>
            <ForkBadge session={session} />
          </button>
          <div
            className={cn(
              'flex items-center gap-1 shrink-0 ml-1',
              session.scheduledTask && '-mr-1',
              needsInput && 'group-hover:pr-6 group-has-[:focus-visible]:pr-6 group-has-[[data-state=open]]:pr-6',
            )}
          >
            {source && variant !== 'project' && (
              <span
                role="img"
                aria-label={`远程：${source.label}`}
                className="inline-flex size-4 shrink-0 items-center justify-center text-primary pointer-events-none transition-opacity group-hover:opacity-0 group-has-[:focus-visible]:opacity-0"
              >
                <Globe aria-hidden="true" className="size-3" />
              </span>
            )}
            {needsInput ? (
              <span
                role="status"
                className="shrink-0 rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] text-blue-500"
              >
                需要用户输入
              </span>
            ) : session.unread ? (
              <TooltipHint content="有未读回复">
                <span
                  role="img"
                  aria-label="会话有未读回复"
                  className="size-2 shrink-0 rounded-full bg-blue-500 transition-transform duration-150 ease-out motion-reduce:transition-none group-hover:-translate-x-12 group-has-[:focus-visible]:-translate-x-12 group-has-[[data-state=open]]:-translate-x-12"
                />
              </TooltipHint>
            ) : null}
            {isRunning && (
              <span className="inline-flex shrink-0 animate-spin text-muted-foreground group-hover:hidden group-has-[:focus-visible]:hidden group-has-[[data-state=open]]:hidden">
                <Loader2 aria-label="会话运行中" className="size-3.5" />
              </span>
            )}
            {session.scheduledTask && (
              <span
                role="img"
                aria-label={`定时任务：${session.scheduledTask.name}`}
                className="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground transition-opacity group-hover:opacity-0 group-has-[:focus-visible]:opacity-0 group-has-[[data-state=open]]:opacity-0"
              >
                <Clock aria-hidden="true" className="size-3" />
              </span>
            )}
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
            <TooltipHint content={source?.disabledReason || (pinned ? '取消置顶会话' : '置顶会话')}>
              <span className={needsInput ? 'hidden' : 'inline-flex'} tabIndex={source?.disabledReason ? 0 : undefined}>
                <button
                  type="button"
                  disabled={Boolean(source?.disabledReason)}
                  hidden={Boolean(needsInput)}
                  aria-label={`${pinned ? '取消置顶会话' : '置顶会话'}：${title}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onTogglePin?.(session.path)
                  }}
                  className={cn(
                    'p-1 hover:text-foreground cursor-pointer rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    pinned ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  {variant === 'pinned' ? <PinOff className="size-3" /> : <Pin className="size-3" />}
                </button>
              </span>
            </TooltipHint>
            <SidebarMoreMenu target={target} className="opacity-100" />
          </div>
        </div>
      </SidebarRowMenu>
    </SidebarHoverCard>
  )
}
