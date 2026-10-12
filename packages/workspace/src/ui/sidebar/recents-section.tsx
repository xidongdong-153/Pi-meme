import type { SidebarSessionEntry } from './sidebar-model'
import { SidebarSection, SidebarSortable } from './sidebar-controls'
import { SessionItem } from './session-item'
import type { SidebarProps } from './sidebar'

export function RecentsSection({
  recentsLimit,
  onChangeLimit,
  entries,
  activeSessionId,
  activeSessionPath,
  onSwitchSession,
  onTogglePin,
  onPrefetchSession,
  sessionsLoading,
  collapsed,
  onToggle,
  sortable,
  onReorder,
}: Pick<
  SidebarProps,
  'activeSessionId' | 'activeSessionPath' | 'onSwitchSession' | 'onTogglePin' | 'onPrefetchSession' | 'sessionsLoading'
> & {
  recentsLimit: number
  onChangeLimit: (limit: number) => void
  entries: SidebarSessionEntry[]
  collapsed: boolean
  onToggle: () => void
  sortable: boolean
  onReorder: (keys: string[]) => void
}) {
  const keys = entries.map((entry) => entry.key)
  const visibleRecents = entries.filter(
    ({ session }, index) =>
      index < recentsLimit || session.running || session.path === activeSessionPath || session.id === activeSessionId,
  )
  return (
    <SidebarSection id="recents" title="最近" collapsed={collapsed} onToggle={onToggle}>
      <div className="space-y-0.5">
        {visibleRecents.map((entry) => (
          <SidebarSortable
            key={entry.key}
            itemKey={entry.key}
            listKey="recents"
            keys={keys}
            enabled={sortable}
            onReorder={onReorder}
          >
            <SessionItem
              session={entry.session}
              variant="recent"
              isActive={activeSessionId === entry.session.id || activeSessionPath === entry.session.path}
              onSwitchSession={onSwitchSession}
              onTogglePin={onTogglePin}
              onPrefetchSession={onPrefetchSession}
            />
          </SidebarSortable>
        ))}
        {entries.length > 8 && (
          <button
            type="button"
            onClick={() =>
              onChangeLimit(recentsLimit >= entries.length ? 8 : Math.min(recentsLimit + 8, entries.length))
            }
            className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer transition-colors block text-left"
          >
            {recentsLimit >= entries.length ? '收起' : '加载更多'}
          </button>
        )}
        {entries.length === 0 && !sessionsLoading && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground/60">暂无历史会话</div>
        )}
      </div>
    </SidebarSection>
  )
}
