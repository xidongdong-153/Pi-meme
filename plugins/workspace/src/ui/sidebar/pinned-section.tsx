import { SidebarMoreMenu, SidebarRowMenu } from './sidebar-menus'
import { Folder, Loader2, PinOff, SquarePen } from 'lucide-react'
import type { PiProjectGroup, PiSessionSummary } from '@pi-meme/contracts/sessions'
import { SessionItem } from './session-item'

export function PinnedSection({
  pinnedProjects,
  pinnedSessions,
  activeSessionId,
  activeSessionPath,
  expandedProjects,
  toggleProject,
  onNewSessionInProject,
  onTogglePin,
  onSwitchSession,
  onPrefetchSession,
}: {
  pinnedProjects: PiProjectGroup[]
  pinnedSessions: PiSessionSummary[]
  activeSessionId?: string
  activeSessionPath?: string
  expandedProjects: Set<string>
  toggleProject: (cwd: string) => void
  onNewSessionInProject: (cwd: string) => void
  onTogglePin: (path: string) => void
  onSwitchSession: (path: string) => void
  onPrefetchSession: (path: string) => void
}) {
  const hasPinned = pinnedProjects.length > 0 || pinnedSessions.length > 0
  return (
    <>
      {hasPinned && (
        <div>
          <div className="px-2 py-1 text-[0.6875rem] font-semibold text-muted-foreground/80 tracking-wider">置顶</div>
          <div className="space-y-0.5">
            {pinnedProjects.map((project) => {
              const hasRunningSession = project.sessions.some((session) => session.running)
              return (
                <SidebarRowMenu key={project.cwd} target={{ kind: 'project', project }}>
                  <div
                    className="group relative flex w-full min-w-0 items-center justify-between rounded-lg pr-2.5 text-xs text-foreground/90 transition-colors hover:bg-secondary/60 cursor-pointer"
                    title={project.cwd}
                    data-project-cwd={project.cwd}
                  >
                    <button
                      type="button"
                      onClick={() => toggleProject(project.cwd)}
                      aria-expanded={expandedProjects.has(project.cwd)}
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
                        title="取消置顶项目"
                        aria-label={`取消置顶项目：${project.name}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          onTogglePin(project.cwd)
                        }}
                        className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring text-muted-foreground hover:text-foreground transition-opacity p-1 cursor-pointer rounded"
                      >
                        <PinOff className="size-3" />
                      </button>

                      <SidebarMoreMenu target={{ kind: 'project', project }} />
                      {/* 项目内有会话运行中：常驻显示，便于监控 */}
                      {hasRunningSession && (
                        <Loader2
                          aria-label="项目内有会话运行中"
                          className="size-3 shrink-0 animate-spin text-primary"
                        />
                      )}
                    </div>
                  </div>
                </SidebarRowMenu>
              )
            })}
            {pinnedSessions.map((session) => (
              <SessionItem
                key={session.path}
                session={session}
                variant="pinned"
                isActive={activeSessionId === session.id || activeSessionPath === session.path}
                onSwitchSession={onSwitchSession}
                onTogglePin={onTogglePin}
                onPrefetchSession={onPrefetchSession}
              />
            ))}
          </div>
        </div>
      )}
    </>
  )
}
