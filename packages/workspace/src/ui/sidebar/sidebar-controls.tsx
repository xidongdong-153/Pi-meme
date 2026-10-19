import { useId, useRef, type HTMLAttributes, type ReactNode } from 'react'
import { ArrowDownUp, ChevronRight, Folder, GripVertical, List, MoreHorizontal, PanelLeft } from 'lucide-react'
import type { SidebarPreferences, SidebarPreferencesPatch } from '@pi-meme/contracts/settings'
import * as Dropdown from '@pi-meme/ui/components/ui/dropdown-menu'
import { cn } from '@pi-meme/ui/lib/utils'
import { reorderSidebarItems } from './sidebar-model'

export function SidebarSection({
  id,
  title,
  collapsed,
  onToggle,
  actions,
  children,
}: {
  id: 'pinned' | 'projects' | 'recents'
  title: string
  collapsed: boolean
  onToggle: () => void
  actions?: ReactNode
  children: ReactNode
}) {
  const contentId = useId()
  return (
    <section data-sidebar-section={id} className="min-w-0">
      <div className="group/section-header flex items-center gap-1 px-2.5 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={contentId}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          <span className="truncate">{title}</span>
          <span
            className={cn(
              'inline-flex transition-transform duration-200 ease-out motion-reduce:transition-none',
              !collapsed && 'rotate-90',
            )}
          >
            <ChevronRight className="size-3" />
          </span>
        </button>
        {actions && (
          <div
            data-sidebar-section-actions
            className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-200 ease-out group-hover/section-header:opacity-100"
          >
            {actions}
          </div>
        )}
      </div>
      <div
        id={contentId}
        inert={collapsed}
        aria-hidden={collapsed || undefined}
        data-sidebar-collapse={collapsed ? 'closed' : 'open'}
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
          collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
        )}
      >
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </section>
  )
}
export function SidebarPreferencesMenu({
  preferences,
  onChange,
  disabled = false,
}: {
  preferences: SidebarPreferences
  onChange: (patch: SidebarPreferencesPatch) => void
  disabled?: boolean
}) {
  return (
    <Dropdown.DropdownMenu>
      <Dropdown.DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="侧边栏显示选项"
          disabled={disabled}
          className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </Dropdown.DropdownMenuTrigger>
      <Dropdown.DropdownMenuContent
        align="end"
        sideOffset={6}
        collisionPadding={4}
        className="w-56 min-w-56 rounded-2xl p-1"
      >
        <Dropdown.DropdownMenuSub>
          <Dropdown.DropdownMenuSubTrigger className="min-h-7 gap-2.5 rounded-xl py-1 text-sm data-[state=open]:bg-secondary">
            <PanelLeft />
            整理侧边栏
          </Dropdown.DropdownMenuSubTrigger>
          <Dropdown.DropdownMenuSubContent sideOffset={12} alignOffset={-4} className="w-45 min-w-45 rounded-2xl p-1">
            <Dropdown.DropdownMenuRadioGroup
              value={preferences.groupMode}
              onValueChange={(value) => {
                if (value === 'projects' || value === 'merged') onChange({ groupMode: value })
              }}
            >
              <Dropdown.DropdownMenuRadioItem value="projects" className="min-h-7 gap-2.5 rounded-xl py-1 text-sm">
                <Folder />
                分项目显示
              </Dropdown.DropdownMenuRadioItem>
              <Dropdown.DropdownMenuRadioItem value="merged" className="min-h-7 gap-2.5 rounded-xl py-1 text-sm">
                <List />
                合并显示
              </Dropdown.DropdownMenuRadioItem>
            </Dropdown.DropdownMenuRadioGroup>
          </Dropdown.DropdownMenuSubContent>
        </Dropdown.DropdownMenuSub>
        <Dropdown.DropdownMenuSub>
          <Dropdown.DropdownMenuSubTrigger className="min-h-7 gap-2.5 rounded-xl py-1 text-sm data-[state=open]:bg-secondary">
            <ArrowDownUp />
            聊天排序方式
          </Dropdown.DropdownMenuSubTrigger>
          <Dropdown.DropdownMenuSubContent sideOffset={12} alignOffset={-4} className="w-45 min-w-45 rounded-2xl p-1">
            <Dropdown.DropdownMenuRadioGroup
              value={preferences.sortMode}
              onValueChange={(value) => {
                if (value === 'recent' || value === 'manual') onChange({ sortMode: value })
              }}
            >
              <Dropdown.DropdownMenuRadioItem value="recent" className="min-h-7 rounded-xl py-1 text-sm">
                最近更新
              </Dropdown.DropdownMenuRadioItem>
              <Dropdown.DropdownMenuRadioItem value="manual" className="min-h-7 rounded-xl py-1 text-sm">
                手动排序
              </Dropdown.DropdownMenuRadioItem>
            </Dropdown.DropdownMenuRadioGroup>
          </Dropdown.DropdownMenuSubContent>
        </Dropdown.DropdownMenuSub>
      </Dropdown.DropdownMenuContent>
    </Dropdown.DropdownMenu>
  )
}
export type SidebarDragProps = Pick<
  HTMLAttributes<HTMLElement>,
  'draggable' | 'onPointerDownCapture' | 'onDragStart' | 'onKeyDown'
>

export function SidebarSortable({
  itemKey,
  listKey,
  keys,
  enabled,
  onReorder,
  children,
}: {
  itemKey: string
  listKey: string
  keys: string[]
  enabled: boolean
  onReorder: (keys: string[]) => void
  children: ReactNode | ((dragProps: SidebarDragProps) => ReactNode)
}) {
  const dragBlocked = useRef(false)
  const dragType = `application/x-pi-sidebar-${encodeURIComponent(listKey).toLowerCase()}`
  const move = (key: string, targetKey: string) => {
    const next = reorderSidebarItems(keys, key, targetKey)
    if (next !== keys) onReorder(next)
  }
  const rowDrag = typeof children === 'function'
  const dragProps: SidebarDragProps = {
    draggable: enabled,
    onPointerDownCapture: (event) => {
      dragBlocked.current = Boolean((event.target as HTMLElement).closest('[data-sidebar-drag-ignore]'))
    },
    onDragStart: (event) => {
      event.stopPropagation()
      if (!enabled || dragBlocked.current || (event.target as HTMLElement).closest('[data-sidebar-drag-ignore]')) {
        event.preventDefault()
        return
      }
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(dragType, JSON.stringify({ listKey, key: itemKey }))
    },
    onKeyDown: (event) => {
      if (!enabled || (event.target as HTMLElement).closest('[data-sidebar-drag-ignore]')) return
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      event.stopPropagation()
      const index = keys.indexOf(itemKey)
      const target = keys[index + (event.key === 'ArrowUp' ? -1 : 1)]
      if (index >= 0 && target !== undefined) move(itemKey, target)
    },
  }
  return (
    <div
      className={cn('group/sortable relative min-w-0', enabled && !rowDrag && 'pl-3')}
      data-sidebar-item-key={itemKey}
      onDragOver={(event) => {
        if (enabled && event.dataTransfer.types.includes(dragType)) {
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
        }
      }}
      onDrop={(event) => {
        if (!enabled || !event.dataTransfer.types.includes(dragType)) return
        event.preventDefault()
        event.stopPropagation()
        try {
          const payload: unknown = JSON.parse(event.dataTransfer.getData(dragType))
          if (
            payload &&
            typeof payload === 'object' &&
            'listKey' in payload &&
            payload.listKey === listKey &&
            'key' in payload &&
            typeof payload.key === 'string'
          )
            move(payload.key, itemKey)
        } catch {
          event.dataTransfer.dropEffect = 'none'
        }
      }}
    >
      {enabled && !rowDrag && (
        <button
          {...dragProps}
          type="button"
          aria-label="拖动排序，方向键上下移动"
          title="拖动排序，方向键上下移动"
          className="absolute left-0 top-1.5 z-10 rounded text-muted-foreground opacity-0 group-hover/sortable:opacity-100 group-focus-within/sortable:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-grab active:cursor-grabbing"
          onClick={(event) => event.stopPropagation()}
        >
          <GripVertical className="size-3" />
        </button>
      )}
      {typeof children === 'function' ? children(dragProps) : children}
    </div>
  )
}
