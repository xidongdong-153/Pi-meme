import { Folder, Plus, SquarePen } from 'lucide-react'
import type { PiProjectGroup } from '@pi-meme/contracts/sessions'
import { ProjectItem } from './project-item'
import type { SidebarProps } from './sidebar'

export function ProjectsSection({
  showAllProjects,
  onToggleAllProjects,
  projects,
  sessionsLoading,
  ready,
  onDirectory,
  cwd,
  projectName,
  expandedProjects,
  expandedProjectItemLimits,
  pinnedSet,
  activeSessionId,
  activeSessionPath,
  toggleProject,
  toggleProjectItems,
  onNewSessionInProject,
  onSwitchSession,
  onTogglePin,
  onPrefetchSession,
}: Pick<
  SidebarProps,
  | 'sessionsLoading'
  | 'ready'
  | 'onDirectory'
  | 'cwd'
  | 'projectName'
  | 'activeSessionId'
  | 'activeSessionPath'
  | 'onNewSessionInProject'
  | 'onSwitchSession'
  | 'onTogglePin'
  | 'onPrefetchSession'
> & {
  showAllProjects: boolean
  onToggleAllProjects: () => void
  projects: PiProjectGroup[]
  expandedProjects: Set<string>
  expandedProjectItemLimits: Set<string>
  pinnedSet: Set<string>
  toggleProject: (cwd: string) => void
  toggleProjectItems: (cwd: string) => void
}) {
  const visibleProjects = showAllProjects
    ? projects
    : projects.filter(
        (project, index) => index < 5 || project.cwd === cwd || project.sessions.some((session) => session.running),
      )
  const hasMoreProjects = projects.length > 5
  return (
    <>
      {/* 项目分区 */}
      <div>
        <div className="flex items-center justify-between px-2 py-1 text-[0.6875rem] font-semibold text-muted-foreground/80 tracking-wider">
          <span>项目</span>
          <button
            type="button"
            onClick={onDirectory}
            disabled={!ready}
            aria-label="新建项目"
            title="新建项目"
            className="rounded p-1 transition-colors duration-200 ease-out hover:bg-secondary disabled:opacity-50"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        <div className="space-y-1">
          {visibleProjects.length === 0 && !sessionsLoading && projectName !== '不在项目中工作' && (
            <div className="group relative flex w-full min-w-0 items-center justify-between rounded-lg px-2.5 py-2 text-xs text-foreground/90 transition-colors duration-200 ease-out hover:bg-secondary/60">
              <button
                type="button"
                disabled={!ready}
                onClick={onDirectory}
                title={cwd}
                className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer text-left overflow-hidden"
              >
                <Folder className="size-3.5 text-muted-foreground shrink-0" />
                <span className="truncate font-medium">{projectName}</span>
              </button>
              <button
                type="button"
                disabled={!ready}
                title="在项目中新建会话"
                aria-label="在项目中新建会话"
                onClick={(e) => {
                  e.stopPropagation()
                  onNewSessionInProject(cwd)
                }}
                className="p-1 hover:text-foreground text-muted-foreground cursor-pointer rounded transition-opacity opacity-0 group-hover:opacity-100"
              >
                <SquarePen className="size-3.5" />
              </button>
            </div>
          )}
          {visibleProjects.map((project) => (
            <ProjectItem
              key={project.cwd}
              project={project}
              cwd={cwd}
              isExpanded={expandedProjects.has(project.cwd)}
              isPinned={pinnedSet.has(project.cwd)}
              isItemsExpandedAll={expandedProjectItemLimits.has(project.cwd)}
              pinnedSet={pinnedSet}
              activeSessionId={activeSessionId}
              activeSessionPath={activeSessionPath}
              onToggle={() => toggleProject(project.cwd)}
              onToggleItems={() => toggleProjectItems(project.cwd)}
              onNewSessionInProject={onNewSessionInProject}
              onSwitchSession={onSwitchSession}
              onTogglePin={onTogglePin}
              onPrefetchSession={onPrefetchSession}
            />
          ))}

          {/* 展开更多项目 / 收起 */}
          {hasMoreProjects && (
            <button
              type="button"
              onClick={onToggleAllProjects}
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer transition-colors block text-left"
            >
              {showAllProjects ? '收起' : '展开显示'}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
