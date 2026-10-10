import type { PiSessionSummary } from '@pi-meme/contracts/sessions'
import { SessionItem } from './session-item'
import type { SidebarProps } from './sidebar'

export function RecentsSection({
  recentsLimit,
  onChangeLimit,
  recents,
  pinnedSet,
  activeSessionId,
  activeSessionPath,
  onSwitchSession,
  onTogglePin,
  onPrefetchSession,
  sessionsLoading,
}: Pick<
  SidebarProps,
  'activeSessionId' | 'activeSessionPath' | 'onSwitchSession' | 'onTogglePin' | 'onPrefetchSession' | 'sessionsLoading'
> & {
  recentsLimit: number
  onChangeLimit: (limit: number) => void
  recents: PiSessionSummary[]
  pinnedSet: Set<string>
}) {
  const visibleRecents = recents.filter(
    (session, index) =>
      index < recentsLimit || session.running || session.path === activeSessionPath || session.id === activeSessionId,
  )
  const hasMoreRecents = recents.length > 8
  return (
    <>
      {/* 最近分区：默认展示前 8 个 */}
      <div>
        <div className="px-2 py-1 text-[0.6875rem] font-semibold text-muted-foreground/80 tracking-wider">最近</div>
        <div className="space-y-0.5">
          {visibleRecents.map((session) => (
            <SessionItem
              key={session.path}
              session={session}
              variant="recent"
              isActive={activeSessionId === session.id || activeSessionPath === session.path}
              isPinned={pinnedSet.has(session.path)}
              onSwitchSession={onSwitchSession}
              onTogglePin={onTogglePin}
              onPrefetchSession={onPrefetchSession}
            />
          ))}

          {/* 最近会话：加载更多 / 收起 */}
          {hasMoreRecents && (
            <button
              type="button"
              onClick={() => {
                if (recentsLimit >= recents.length) {
                  onChangeLimit(8)
                } else {
                  onChangeLimit(Math.min(recentsLimit + 8, recents.length))
                }
              }}
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer transition-colors block text-left"
            >
              {recentsLimit >= recents.length ? '收起' : '加载更多'}
            </button>
          )}

          {recents.length === 0 && !sessionsLoading && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground/60">暂无历史会话</div>
          )}
        </div>
      </div>
    </>
  )
}
