import type { SidebarSessionEntry } from './sidebar-model'
import { SidebarSection, SidebarSortable } from './sidebar-controls'
import { SessionItem } from './session-item'
import type { SidebarProps } from './sidebar'
import { Fragment, type ReactNode } from 'react'

function recentGroup(session: SidebarSessionEntry['session'], today: Date): string {
  const time = Date.parse(session.completedAt ?? session.created)
  if (time >= today.getTime()) return '今天'
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (time >= yesterday.getTime()) return '昨天'
  const week = new Date(today)
  week.setDate(week.getDate() - 6)
  return time >= week.getTime() ? '近 7 天' : '更早'
}

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
  actions,
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
  actions?: ReactNode
}) {
  const keys = entries.map((entry) => entry.key)
  const visibleRecents = entries.filter(
    ({ session }, index) =>
      index < recentsLimit || session.running || session.path === activeSessionPath || session.id === activeSessionId,
  )
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const groups = sortable ? [] : visibleRecents.map((entry) => recentGroup(entry.session, today))
  return (
    <SidebarSection id="recents" title="最近" collapsed={collapsed} onToggle={onToggle} actions={actions}>
      <div className="space-y-0.5">
        {visibleRecents.map((entry, index) => (
          <Fragment key={entry.key}>
            {groups[index] && groups[index] !== groups[index - 1] && (
              <div className="px-2.5 pb-1 pt-2 text-[0.6875rem] text-muted-foreground/60">{groups[index]}</div>
            )}
            <SidebarSortable itemKey={entry.key} listKey="recents" keys={keys} enabled={sortable} onReorder={onReorder}>
              <SessionItem
                session={entry.session}
                variant="recent"
                isActive={activeSessionId === entry.session.id || activeSessionPath === entry.session.path}
                onSwitchSession={onSwitchSession}
                onTogglePin={onTogglePin}
                onPrefetchSession={onPrefetchSession}
              />
            </SidebarSortable>
          </Fragment>
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
