import { Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SidebarProjectEntry } from './sidebar-model'
import { SidebarSection, SidebarSortable } from './sidebar-controls'
import { ProjectItem, type ProjectItemProps } from './project-item'

export function ProjectsSection({
  entries,
  collapsed,
  onToggle,
  showAllProjects,
  onToggleAllProjects,
  ready,
  onDirectory,
  menu,
  projectProps,
  expandedProjects,
  expandedProjectItemLimits,
  toggleProject,
  toggleProjectItems,
  onSelectProject,
  sortable,
  reorderEnabled,
  onReorder,
  onReorderSessions,
}: {
  entries: SidebarProjectEntry[]
  collapsed: boolean
  onToggle: () => void
  showAllProjects: boolean
  onToggleAllProjects: () => void
  ready: boolean
  onDirectory: () => void
  menu?: ReactNode
  projectProps: Pick<
    ProjectItemProps,
    | 'cwd'
    | 'pinnedSet'
    | 'activeSessionId'
    | 'activeSessionPath'
    | 'onNewSessionInProject'
    | 'onSwitchSession'
    | 'onTogglePin'
    | 'onPrefetchSession'
  >
  expandedProjects: Set<string>
  expandedProjectItemLimits: Set<string>
  toggleProject: (cwd: string) => void
  toggleProjectItems: (cwd: string) => void
  onSelectProject?: (cwd: string) => void
  sortable: boolean
  reorderEnabled: boolean
  onReorder: (keys: string[]) => void
  onReorderSessions: (listKey: string, keys: string[]) => void
}) {
  const keys = entries.map((entry) => entry.key)
  const visibleProjects = showAllProjects
    ? entries
    : entries.filter(
        ({ project }, index) =>
          index < 5 ||
          project.cwd === projectProps.cwd ||
          project.sessions.some(
            (session) =>
              session.running ||
              session.path === projectProps.activeSessionPath ||
              session.id === projectProps.activeSessionId,
          ),
      )
  return (
    <SidebarSection
      id="projects"
      title="项目"
      collapsed={collapsed}
      onToggle={onToggle}
      actions={
        <>
          {menu}
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
        </>
      }
    >
      <div className="space-y-1">
        {visibleProjects.map(({ key, serviceId, project }) => (
          <SidebarSortable
            key={key}
            itemKey={key}
            listKey="projects"
            keys={keys}
            enabled={reorderEnabled}
            onReorder={onReorder}
          >
            {(dragProps) => (
              <ProjectItem
                {...projectProps}
                dragProps={dragProps}
                project={project}
                isExpanded={expandedProjects.has(project.cwd)}
                isPinned={false}
                isItemsExpandedAll={expandedProjectItemLimits.has(project.cwd)}
                onToggle={() => toggleProject(project.cwd)}
                onToggleItems={() => toggleProjectItems(project.cwd)}
                onSelectProject={onSelectProject}
                sortable={{
                  serviceId,
                  enabled: sortable,
                  onReorder: (keys) => onReorderSessions(`project:${key}`, keys),
                }}
              />
            )}
          </SidebarSortable>
        ))}
        {entries.length > 5 && (
          <button
            type="button"
            onClick={onToggleAllProjects}
            className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer transition-colors block text-left"
          >
            {showAllProjects ? '收起' : '展开显示'}
          </button>
        )}
      </div>
    </SidebarSection>
  )
}
