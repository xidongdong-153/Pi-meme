import { SidebarMoreMenu, SidebarRowMenu } from './sidebar-menus'
import { Folder, Loader2, Pin, SquarePen } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'
import type { PiProjectGroup } from '@pi-meme/contracts/sessions'
import { SessionItem } from './session-item'

export type ProjectItemProps = {
  project: PiProjectGroup
  cwd: string
  isExpanded: boolean
  isPinned: boolean
  isItemsExpandedAll: boolean
  pinnedSet?: Set<string>
  activeSessionId?: string
  activeSessionPath?: string
  onToggle: () => void
  onToggleItems: () => void
  onNewSessionInProject: (cwd: string) => void
  onTogglePin: (path: string) => void
  onSwitchSession: (path: string) => void
  onPrefetchSession: (path: string) => void
}

export function ProjectItem({
  project,
  cwd,
  isExpanded,
  isPinned,
  isItemsExpandedAll,
  pinnedSet,
  activeSessionId,
  activeSessionPath,
  onToggle,
  onToggleItems,
  onNewSessionInProject,
  onTogglePin,
  onSwitchSession,
  onPrefetchSession,
}: ProjectItemProps) {
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
  const isContentVisible = isExpanded && project.sessions.length > 0
  const hasRunningSession = project.sessions.some((session) => session.running)

  return (
    <div key={project.cwd} className="space-y-0.5">
      <SidebarRowMenu target={{ kind: 'project', project }}>
        <div
          className={cn(
            'group relative flex w-full min-w-0 items-center justify-between rounded-lg pr-2.5 text-xs transition-colors cursor-pointer',
            isCurrentCwd ? 'bg-secondary/70 font-medium text-foreground' : 'text-foreground/85 hover:bg-secondary/50',
          )}
          title={project.cwd}
          data-project-cwd={project.cwd}
        >
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isExpanded}
            className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden pl-2.5 py-1.5 text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Folder className="size-3.5 text-primary shrink-0" />
            <span className="truncate font-medium">{project.name}</span>
          </button>
          <div className="flex items-center gap-1 shrink-0 ml-1">
            <button
              type="button"
              title="在项目中新建会话"
              aria-label={`在项目中新建会话：${project.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onNewSessionInProject(project.cwd)
              }}
              className="p-1 hover:text-foreground text-muted-foreground cursor-pointer rounded transition-opacity opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <SquarePen className="size-3.5" />
            </button>

            <button
              type="button"
              title={isPinned ? '取消置顶项目' : '置顶项目'}
              aria-label={`${isPinned ? '取消置顶项目' : '置顶项目'}：${project.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onTogglePin(project.cwd)
              }}
              className={cn(
                'transition-opacity p-1 hover:text-foreground cursor-pointer rounded opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isPinned ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <Pin className="size-3" />
            </button>

            <SidebarMoreMenu target={{ kind: 'project', project }} />
            {/* 项目内有会话运行中：常驻显示，便于监控 */}
            {hasRunningSession && (
              <Loader2 aria-label="项目内有会话运行中" className="size-3 shrink-0 animate-spin text-primary" />
            )}
          </div>
        </div>
      </SidebarRowMenu>
      {/* 展开的会话列表：默认展示前 5 个，支持展开显示。常驻挂载以便折叠时行高缓动 */}
      <div
        aria-hidden={!isContentVisible}
        inert={!isContentVisible}
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
          isContentVisible ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="ml-3 border-l border-border/40 pl-2 space-y-0.5 py-0.5">
            {visibleSessions.map((session) => (
              <SessionItem
                key={session.path}
                session={session}
                variant="project"
                isActive={activeSessionId === session.id || activeSessionPath === session.path}
                isPinned={pinnedSet?.has(session.path) ?? false}
                onSwitchSession={onSwitchSession}
                onTogglePin={onTogglePin}
                onPrefetchSession={onPrefetchSession}
              />
            ))}

            {/* 项目内部展开显示更多会话 */}
            {hasMoreSessions && (
              <button
                type="button"
                onClick={() => onToggleItems()}
                className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer transition-colors block text-left"
              >
                {isItemsExpandedAll ? '收起' : '展开显示'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
