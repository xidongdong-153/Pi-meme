import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SidebarRowMenu } from './sidebar-menus'
import { ChevronDown, ChevronRight, Folder, Globe, Pin, PinOff, SquarePen } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@pi-meme/ui/components/ui/popover'
import type { SidebarSource } from './sidebar-source'
import { cn } from '@pi-meme/ui/lib/utils'
import type { PiProjectGroup } from '@pi-meme/contracts/sessions'
import { SessionItem } from './session-item'
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
  const [detailsOpen, setDetailsOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const keepDetails = () => clearTimeout(timer.current)
  const showDetails = () => {
    keepDetails()
    if (details && !anchor.current?.querySelector('[aria-haspopup="menu"][data-state="open"]'))
      timer.current = setTimeout(setDetailsOpen, 300, true)
  }
  const hideDetails = () => {
    keepDetails()
    timer.current = setTimeout(setDetailsOpen, 200, false)
  }
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
      <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
        <PopoverAnchor virtualRef={anchor} />
        <SidebarRowMenu target={{ kind: 'project', project }}>
          <div
            {...dragProps}
            ref={anchor}
            onDragStart={(event) => {
              keepDetails()
              setDetailsOpen(false)
              dragProps?.onDragStart?.(event)
            }}
            onPointerEnter={showDetails}
            onPointerLeave={hideDetails}
            onContextMenuCapture={() => {
              keepDetails()
              setDetailsOpen(false)
            }}
            onPointerDownCapture={(event) => {
              dragProps?.onPointerDownCapture?.(event)
              if ((event.target as HTMLElement).closest('[aria-haspopup="menu"]')) {
                keepDetails()
                setDetailsOpen(false)
              }
            }}
            onKeyDownCapture={(event) => {
              if (event.key === 'Escape') {
                keepDetails()
                setDetailsOpen(false)
              }
            }}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) hideDetails()
            }}
            className={cn(
              'group relative flex w-full min-w-0 items-center justify-between rounded-lg pr-1.5 text-xs transition-colors duration-150 ease-out cursor-pointer',
              isCurrentCwd
                ? 'bg-secondary/50 font-medium text-foreground'
                : 'text-foreground/85 hover:bg-secondary/30 hover:text-foreground',
              dragProps?.draggable && 'cursor-grab active:cursor-grabbing',
            )}
            title={details ? undefined : project.cwd}
            data-project-cwd={project.cwd}
          >
            <button
              type="button"
              onClick={() => (onSelectProject ? onSelectProject(project.cwd) : onToggle())}
              aria-expanded={onSelectProject ? undefined : isExpanded}
              onFocus={showDetails}
              className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden py-1.5 pl-1.5 pr-1 text-left rounded cursor-[inherit] transition-[padding] duration-150 ease-out group-hover:pr-14 group-focus-within:pr-14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {!onSelectProject && (
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    'size-3 shrink-0 text-muted-foreground/50 transition-transform duration-200',
                    isExpanded && 'rotate-90 text-foreground/75',
                  )}
                />
              )}
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
                    title={source.description}
                    className="absolute -bottom-0.5 -right-1 rounded-full text-primary"
                  >
                    <Globe aria-hidden="true" className="size-2.5" />
                  </span>
                )}
              </span>
              <span
                className={cn(
                  'min-w-0 truncate font-medium transition-[mask-image] duration-150',
                  'group-hover:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent_100%)] group-hover:[-webkit-mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent_100%)]',
                  'group-focus-within:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent_100%)] group-focus-within:[-webkit-mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent_100%)]',
                )}
              >
                {project.name}
              </span>
            </button>

            {/* 远程来源标签：平时展示，有详情时支持点击打开详情，hover/focus 时淡出，腾出右侧空间给浮动操作按钮 */}
            {source &&
              (details ? (
                <button
                  type="button"
                  data-project-source-label
                  title={source.description}
                  aria-label={`远程项目详情：${project.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    keepDetails()
                    setDetailsOpen((value) => !value)
                  }}
                  className="ml-1 max-w-[76px] shrink-0 truncate text-[0.625rem] font-normal text-muted-foreground transition-opacity duration-150 hover:text-foreground cursor-pointer group-hover:opacity-0 group-focus-within:opacity-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {source.label}
                </button>
              ) : (
                <span
                  data-project-source-label
                  title={source.description}
                  className="ml-1 max-w-[76px] shrink-0 truncate text-[0.625rem] font-normal text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0"
                >
                  {source.label}
                </span>
              ))}

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
              <button
                type="button"
                title={source?.disabledReason || '在项目中新建会话'}
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

              <button
                type="button"
                title={source?.disabledReason || (isPinned ? '取消置顶项目' : '置顶项目')}
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
            </div>
          </div>
        </SidebarRowMenu>
        {details && (
          <PopoverContent
            side="right"
            align="start"
            aria-label={`远程项目：${project.name}`}
            className="w-80 max-w-[calc(100vw-24px)] p-3"
            onPointerEnter={keepDetails}
            onPointerLeave={hideDetails}
            onFocusCapture={keepDetails}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) hideDetails()
            }}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            {details}
          </PopoverContent>
        )}
      </Popover>
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
            <div className="ml-3.5 border-l border-border/30 pl-2 space-y-0.5 py-0.5">
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
                  <ChevronDown
                    className={cn('size-3 transition-transform duration-200', isItemsExpandedAll && 'rotate-180')}
                  />
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
