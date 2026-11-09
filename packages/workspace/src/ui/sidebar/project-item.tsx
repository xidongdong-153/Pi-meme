import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { useRef, type ReactNode } from 'react'
import { SidebarRowMenu, useSidebarMenus } from './sidebar-menus'
import { Folder, Globe, MessageCircle, Pin, PinOff, Settings2, SquarePen } from 'lucide-react'
import { SidebarHoverCard } from './sidebar-hover-card'
import type { SidebarSource } from './sidebar-source'
import { cn } from '@pi-meme/ui/lib/utils'
import type { PiProjectGroup } from '@pi-meme/contracts/sessions'
import { SessionItem } from './session-item'
import { SidebarTitle } from './sidebar-title'
import { SidebarSortable, type SidebarDragProps } from './sidebar-controls'
import { sidebarItemKey } from './sidebar-model'

export type ProjectItemProps = {
  project: PiProjectGroup
  serviceId?: string
  source?: SidebarSource
  details?: ReactNode
  cwd: string
  isExpanded: boolean
  isPinned: boolean
  isItemsExpandedAll: boolean
  pinnedSet?: Set<string>
  activeSessionId?: string
  activeSessionPath?: string
  onSelectProject?: (cwd: string) => void
  dragProps?: SidebarDragProps
  sortable?: { serviceId: string; enabled: boolean; onReorder: (keys: string[]) => void }
  onToggle: () => void
  onToggleItems: () => void
  onNewSessionInProject: (cwd: string) => void
  onTogglePin: (path: string) => void
  onSwitchSession: (path: string) => void
  onPrefetchSession: (path: string) => void
}

export function ProjectItem({
  project,
  serviceId: explicitServiceId,
  source,
  details,
  cwd,
  isExpanded,
  isPinned,
  isItemsExpandedAll,
  pinnedSet,
  activeSessionId,
  activeSessionPath,
  onToggle,
  onSelectProject,
  dragProps,
  sortable,
  onToggleItems,
  onNewSessionInProject,
  onTogglePin,
  onSwitchSession,
  onPrefetchSession,
}: ProjectItemProps) {
  const menus = useSidebarMenus()
  const row = useRef<HTMLDivElement>(null)
  const disabledReason = source?.disabledReason ?? menus.disabledReason
  const isCurrentCwd = project.cwd === cwd
  const sessionThreshold = 5
  const visibleSessions = isItemsExpandedAll
    ? project.sessions
    : project.sessions.filter(
        (session, index) =>
          index < sessionThreshold ||
          session.running ||
          session.path === activeSessionPath ||
          session.id === activeSessionId,
      )
  const hasMoreSessions = project.sessions.length > sessionThreshold
  const isContentVisible = !onSelectProject && isExpanded && project.sessions.length > 0
  const serviceId = explicitServiceId ?? sortable?.serviceId ?? 'local'
  const sessionKeys = project.sessions.map((session) => sidebarItemKey(serviceId, 'session', session.path))

  return (
    <div key={project.cwd} className="space-y-0.5">
      <SidebarHoverCard
        label={`项目预览：${project.name}`}
        content={(close) => (
          <div className="space-y-2.5">
            {details ?? (
              <>
                <div className="flex items-start gap-2">
                  <Folder aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <h3 className="min-w-0 flex-1 pt-px font-semibold [overflow-wrap:anywhere]">{project.name}</h3>
                  <button
                    type="button"
                    disabled={Boolean(disabledReason)}
                    aria-label={`${isPinned ? '取消置顶项目' : '置顶项目'}：${project.name}`}
                    onClick={() => onTogglePin(project.cwd)}
                    className={cn(
                      'shrink-0 rounded p-0.5 hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      isPinned ? 'text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                  </button>
                </div>
                <div className="flex items-center gap-2 text-foreground/90">
                  <MessageCircle aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span>{project.sessionCount} 次聊天</span>
                </div>
                <div className="flex items-start gap-2 border-t border-border/70 pt-2.5 text-foreground/90">
                  <Folder aria-hidden="true" className="mt-px size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{project.cwd}</span>
                </div>
              </>
            )}
            <div className="border-t border-border/70 pt-1.5">
              <button
                type="button"
                disabled={Boolean(disabledReason)}
                aria-label={`编辑项目：${project.name}`}
                onClick={() => {
                  menus.dialogTrigger.current = row.current?.querySelector<HTMLButtonElement>('button') ?? null
                  close()
                  menus.rename({ kind: 'project', project })
                  menus.dialogOpening.current = false
                }}
                className="flex w-full items-center gap-2 rounded-md px-0.5 py-1 text-left text-foreground/90 hover:bg-background/40 hover:text-foreground cursor-pointer disabled:cursor-default disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Settings2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                编辑项目
              </button>
              {disabledReason && <p className="pt-1 text-[11px] text-muted-foreground">{disabledReason}</p>}
            </div>
          </div>
        )}
      >
        <SidebarRowMenu target={{ kind: 'project', project }}>
          <div
            {...dragProps}
            ref={row}
            className={cn(
              'group relative flex w-full min-w-0 items-center justify-between rounded-lg pr-1.5 text-xs transition-colors duration-150 ease-out cursor-pointer',
              isCurrentCwd
                ? 'bg-secondary/50 font-medium text-foreground'
                : 'text-foreground/85 hover:bg-secondary/30 hover:text-foreground',
              dragProps?.draggable && 'cursor-grab active:cursor-grabbing',
            )}
            data-project-cwd={project.cwd}
          >
            <button
              type="button"
              onClick={() => (onSelectProject ? onSelectProject(project.cwd) : onToggle())}
              aria-expanded={onSelectProject ? undefined : isExpanded}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden py-1.5 pl-2 pr-1 text-left rounded cursor-[inherit] transition-[padding] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                !source && 'group-hover:pr-14 group-focus-within:pr-14',
              )}
            >
              <span className={cn('relative shrink-0', source ? 'size-4' : 'size-3.5')}>
                <Folder
                  data-project-folder-icon
                  aria-hidden="true"
                  className={cn('text-muted-foreground', source ? 'size-4' : 'size-3.5')}
                />
                {source && (
                  <span
                    role="img"
                    aria-label={`远程：${source.label}`}
                    className="absolute -bottom-0.5 -right-1 rounded-full text-primary"
                  >
                    <Globe aria-hidden="true" className="size-2.5" />
                  </span>
                )}
              </span>
              <SidebarTitle className="font-medium">{project.name}</SidebarTitle>
            </button>

            {source && (
              <span
                data-project-source-label
                className="ml-1 mr-12 max-w-[76px] shrink-0 truncate text-[0.625rem] font-normal text-muted-foreground"
              >
                {source.label}
              </span>
            )}

            {/* 悬浮操作按钮组：采用绝对定位浮在右侧，hover/focus 时浮现，遮盖在最右侧，不挤压项目名称 */}
            <div
              data-sidebar-drag-ignore
              draggable={false}
              className={cn(
                'absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 rounded',
                'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto',
                'transition-opacity duration-150 ease-out',
              )}
            >
              <TooltipHint content={source?.disabledReason || '在项目中新建会话'}>
                <span className="inline-flex" tabIndex={source?.disabledReason ? 0 : undefined}>
                  <button
                    type="button"
                    disabled={Boolean(source?.disabledReason)}
                    aria-label={`在项目中新建会话：${project.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onNewSessionInProject(project.cwd)
                    }}
                    className="p-1 hover:text-foreground text-muted-foreground cursor-pointer rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <SquarePen className="size-3.5" />
                  </button>
                </span>
              </TooltipHint>

              <TooltipHint content={source?.disabledReason || (isPinned ? '取消置顶项目' : '置顶项目')}>
                <span className="inline-flex" tabIndex={source?.disabledReason ? 0 : undefined}>
                  <button
                    type="button"
                    disabled={Boolean(source?.disabledReason)}
                    aria-label={`${isPinned ? '取消置顶项目' : '置顶项目'}：${project.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onTogglePin(project.cwd)
                    }}
                    className={cn(
                      'p-1 hover:text-foreground cursor-pointer rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      isPinned ? 'text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {isPinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
                  </button>
                </span>
              </TooltipHint>
            </div>
          </div>
        </SidebarRowMenu>
      </SidebarHoverCard>
      {/* 展开的会话列表：默认展示前 5 个，支持展开显示。常驻挂载以便折叠时行高缓动 */}
      {!onSelectProject && (
        <div
          aria-hidden={!isContentVisible}
          inert={!isContentVisible}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
            isContentVisible ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="space-y-1 py-0.5">
              {visibleSessions.map((session) => (
                <SidebarSortable
                  key={session.path}
                  itemKey={sidebarItemKey(serviceId, 'session', session.path)}
                  listKey={`project:${sidebarItemKey(serviceId, 'project', project.cwd)}`}
                  keys={sessionKeys}
                  enabled={sortable?.enabled ?? false}
                  onReorder={(keys) => sortable?.onReorder(keys)}
                >
                  <SessionItem
                    session={session}
                    variant="project"
                    projectName={project.name}
                    source={source}
                    isActive={activeSessionId === session.id || activeSessionPath === session.path}
                    isPinned={pinnedSet?.has(session.path) ?? false}
                    onSwitchSession={onSwitchSession}
                    onTogglePin={onTogglePin}
                    onPrefetchSession={onPrefetchSession}
                  />
                </SidebarSortable>
              ))}

              {/* 项目内部展开显示更多会话 */}
              {hasMoreSessions && (
                <button
                  type="button"
                  onClick={() => onToggleItems()}
                  className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer transition-colors w-full text-left"
                >
                  <span>{isItemsExpandedAll ? '收起' : '展开显示'}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
