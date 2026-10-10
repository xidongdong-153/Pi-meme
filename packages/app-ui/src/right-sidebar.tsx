import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { cn } from '@pi-meme/ui/lib/utils'

export type RightSidebarTab = 'git' | 'session-tree' | 'subagents' | 'plan'

const tabs: Array<{ id: RightSidebarTab; label: string }> = [
  { id: 'git', label: 'Git 变更' },
  { id: 'session-tree', label: '会话树' },
  { id: 'subagents', label: '子代理' },
  { id: 'plan', label: '计划' },
]

export function RightSidebar({
  tab,
  onTab,
  onClose,
  width,
  children,
}: {
  tab: RightSidebarTab
  onTab: (tab: RightSidebarTab) => void
  onClose: () => void
  width: number
  children: ReactNode
}) {
  return (
    <aside
      aria-label="右侧栏"
      style={{ width }}
      onKeyDown={(event) => {
        if (
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          (event.target as HTMLElement).closest('[role="dialog"]')
        )
          return
        event.stopPropagation()
        onClose()
      }}
      className="flex h-full min-h-0 shrink-0 flex-col border-l border-border bg-card/95"
    >
      <div
        role="tablist"
        aria-label="右侧栏标签"
        className="flex h-10 shrink-0 items-center gap-1 border-b border-border/70 px-2"
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => onTab(item.id)}
            className={cn(
              'rounded px-2 py-1 text-xs transition-colors',
              tab === item.id
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        ))}
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onClose}
          aria-label="关闭右侧栏"
          title="关闭右侧栏"
          className="ml-auto"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </aside>
  )
}
