import { useEffect, useLayoutEffect, useRef } from 'react'
import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { Clock, Folder, GitFork, Globe, Laptop, Loader2, MessageCircle, Pin, PinOff } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'
import { sessionActivityPhase, type PiSessionSummary } from '@pi-meme/contracts/sessions'
import { formatSessionTitle } from './session-title'
import { SidebarTitle } from './sidebar-title'
import type { SidebarDragProps } from './sidebar-controls'
import type { SidebarSource } from './sidebar-source'
import { SidebarMoreMenu, SidebarRowMenu, type MenuTarget } from './sidebar-menus'
import { SidebarHoverCard } from './sidebar-hover-card'
import { activityTime } from './session-details'

function SyncedSpinner() {
  const ref = useRef<HTMLSpanElement>(null)
  const sync = () => {
    const animations = ref.current?.getAnimations?.()
    if (!animations?.length) return
    for (const animation of animations) {
      if ('animationName' in animation && animation.animationName === 'sidebar-spin') animation.startTime = 0
    }
  }
  useLayoutEffect(sync, [])
  return (
    <span
      ref={ref}
      onAnimationStart={sync}
      className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground sidebar-spin"
    >
      <Loader2 aria-label="会话运行中" className="size-3.5" />
    </span>
  )
}

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
  const phase = sessionActivityPhase(session)
  const isRunning = (phase === 'running' || phase === 'submitting') && (!source || source.connected)
  const hasRightMeta = Boolean(isRunning || session.scheduledTask || (source && variant !== 'project'))
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
          {...dragProps}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={cancelPrefetch}
          className={cn(
            'group relative flex w-full min-w-0 items-center rounded-lg px-2 py-1 text-xs transition-colors duration-150 ease-out motion-reduce:transition-none cursor-pointer',
            isActive
              ? 'bg-secondary/50 font-medium text-foreground'
              : variant === 'project'
                ? 'text-muted-foreground hover:bg-secondary/30 hover:text-foreground'
                : 'text-foreground/85 hover:bg-secondary/30 hover:text-foreground',
            source && !source.connected && 'opacity-65',
            dragProps?.draggable && 'cursor-grab active:cursor-grabbing',
          )}
          data-session-path={session.path}
        >
          <button
            type="button"
            aria-current={isActive ? 'true' : undefined}
            onClick={() => onSwitchSession(session.path)}
            onFocus={handleMouseEnter}
            onBlur={cancelPrefetch}
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden py-0.5 pr-1 text-left rounded cursor-[inherit] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {variant === 'pinned' && (
              <MessageCircle aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <SidebarTitle>{title}</SidebarTitle>
            <ForkBadge session={session} />
          </button>
          {needsInput ? (
            <span
              role="status"
              className="ml-1.5 shrink-0 rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] text-blue-500"
            >
              需要用户输入
            </span>
          ) : session.unread ? (
            <TooltipHint content="有未读回复">
              <span
                role="img"
                aria-label="会话有未读回复"
                className="ml-1.5 size-2 shrink-0 rounded-full bg-blue-500"
              />
            </TooltipHint>
          ) : null}
          {hasRightMeta && (
            <div className="ml-1.5 flex max-w-24 shrink-0 items-center justify-end gap-1 overflow-hidden pointer-events-none transition-[max-width,opacity,margin] duration-150 ease-out motion-reduce:transition-none group-hover:ml-0 group-hover:max-w-0 group-hover:opacity-0 group-has-[:focus-visible]:ml-0 group-has-[:focus-visible]:max-w-0 group-has-[:focus-visible]:opacity-0 group-has-[[data-state=open]]:ml-0 group-has-[[data-state=open]]:max-w-0 group-has-[[data-state=open]]:opacity-0">
              {isRunning && <SyncedSpinner />}
              {session.scheduledTask && (
                <span
                  role="img"
                  aria-label={`定时任务：${session.scheduledTask.name}`}
                  className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground"
                >
                  <Clock aria-hidden="true" className="size-3.5" />
                </span>
              )}
              {source && variant !== 'project' && (
                <span
                  role="img"
                  aria-label={`远程：${source.label}`}
                  className={cn(
                    'inline-flex size-4 shrink-0 items-center justify-center',
                    source.connected ? 'text-primary' : 'text-muted-foreground/70',
                  )}
                >
                  <Globe aria-hidden="true" className="size-3.5" />
                </span>
              )}
            </div>
          )}
          <span
            aria-hidden="true"
            className={cn(
              'w-0 shrink-0 transition-[width] duration-150 ease-out motion-reduce:transition-none',
              needsInput
                ? 'group-hover:w-[28px] group-has-[:focus-visible]:w-[28px] group-has-[[data-state=open]]:w-[28px]'
                : 'group-hover:w-[52px] group-has-[:focus-visible]:w-[52px] group-has-[[data-state=open]]:w-[52px]',
            )}
          />
          <div
            data-sidebar-drag-ignore
            draggable={false}
            className={cn(
              'absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 rounded',
              'opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 group-has-[[data-state=open]]:opacity-100',
              'pointer-events-none group-hover:pointer-events-auto group-has-[:focus-visible]:pointer-events-auto group-has-[[data-state=open]]:pointer-events-auto',
              'transition-opacity duration-150 ease-out motion-reduce:transition-none',
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
                    'inline-flex size-6 items-center justify-center rounded hover:bg-secondary/70 hover:text-foreground cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    pinned ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  {variant === 'pinned' ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
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
