import type { SidebarEntry } from './sidebar-model'
import { SidebarSection, SidebarSortable } from './sidebar-controls'
import { ProjectItem, type ProjectItemProps } from './project-item'
import { SessionItem } from './session-item'

export function PinnedSection({
  entries,
  collapsed,
  onToggle,
  projectProps,
  expandedProjects,
  expandedProjectItemLimits,
  toggleProject,
  toggleProjectItems,
  sortable,
  reorderEnabled,
  onReorder,
  onReorderSessions,
}: {
  entries: SidebarEntry[]
  collapsed: boolean
  onToggle: () => void
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
  sortable: boolean
  reorderEnabled: boolean
  onReorder: (keys: string[]) => void
  onReorderSessions: (listKey: string, keys: string[]) => void
}) {
  if (!entries.length) return null
  const keys = entries.map((entry) => entry.key)
  return (
    <SidebarSection id="pinned" title="置顶" collapsed={collapsed} onToggle={onToggle}>
      <div className="space-y-0.5">
        {entries.map((entry) => (
          <SidebarSortable
            key={entry.key}
            itemKey={entry.key}
            listKey="pinned"
            keys={keys}
            enabled={reorderEnabled}
            onReorder={onReorder}
          >
            {entry.kind === 'project' ? (
              (dragProps) => (
                <ProjectItem
                  dragProps={dragProps}
                  {...projectProps}
                  project={entry.project}
                  isExpanded={expandedProjects.has(entry.project.cwd)}
                  isPinned
                  isItemsExpandedAll={expandedProjectItemLimits.has(entry.project.cwd)}
                  onToggle={() => toggleProject(entry.project.cwd)}
                  onToggleItems={() => toggleProjectItems(entry.project.cwd)}
                  sortable={{
                    serviceId: entry.serviceId,
                    enabled: sortable,
                    onReorder: (keys) => onReorderSessions(`project:${entry.key}`, keys),
                  }}
                />
              )
            ) : (
              <SessionItem
                session={entry.session}
                variant="pinned"
                isActive={
                  entry.session.path === projectProps.activeSessionPath ||
                  entry.session.id === projectProps.activeSessionId
                }
                onSwitchSession={projectProps.onSwitchSession}
                onTogglePin={projectProps.onTogglePin}
                onPrefetchSession={projectProps.onPrefetchSession}
              />
            )}
          </SidebarSortable>
        ))}
      </div>
    </SidebarSection>
  )
}
