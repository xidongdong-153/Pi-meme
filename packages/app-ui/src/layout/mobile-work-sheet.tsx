import { useRef, useState, type ReactNode } from 'react'
import { Blocks, FileCode2, FileDiff, Lightbulb, Maximize2, Minimize2, Paperclip, Users } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { cn } from '@pi-meme/ui/lib/utils'

export type MobileWorkSheetTab = 'plan' | 'changes' | 'sources' | 'file' | 'subagents' | 'context'

export type MobileWorkSheetSection = {
  id: MobileWorkSheetTab
  label: string
  badge?: number
  content: ReactNode
}

const TAB_ICONS: Record<MobileWorkSheetTab, typeof Lightbulb> = {
  plan: Lightbulb,
  changes: FileDiff,
  sources: Paperclip,
  file: FileCode2,
  subagents: Users,
  context: Blocks,
}

export function MobileWorkSheet({
  open,
  onOpenChange,
  activeTab,
  onTabChange,
  sections,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  activeTab: MobileWorkSheetTab
  onTabChange: (tab: MobileWorkSheetTab) => void
  sections: readonly MobileWorkSheetSection[]
}) {
  const [expanded, setExpanded] = useState(false)
  const [dragOffsetY, setDragOffsetY] = useState(0)
  const dragRef = useRef<{ startY: number } | null>(null)
  const resolved = sections.find((item) => item.id === activeTab) ?? sections[0]

  const onDragStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1) return
    dragRef.current = { startY: event.touches[0]!.clientY }
    setDragOffsetY(0)
  }

  const onDragMove = (event: React.TouchEvent<HTMLDivElement>) => {
    if (!dragRef.current || event.touches.length !== 1) return
    const delta = event.touches[0]!.clientY - dragRef.current.startY
    // 上拉给阻尼，下拉跟手
    setDragOffsetY(delta < 0 ? Math.max(-44, delta * 0.35) : Math.min(260, delta))
  }

  const onDragEnd = () => {
    if (!dragRef.current) return
    const delta = dragOffsetY
    dragRef.current = null
    setDragOffsetY(0)
    if (delta < -24) {
      setExpanded(true)
    } else if (delta > 84) {
      if (expanded) setExpanded(false)
      else onOpenChange(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          dragRef.current = null
          setDragOffsetY(0)
        }
        onOpenChange(next)
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        overlayClassName="bg-black/50 backdrop-blur-[1px]"
        closeButtonProps={{
          'aria-label': '关闭工作区产出',
          className:
            'right-3 top-3.5 inline-flex size-9 items-center justify-center rounded-xl text-muted-foreground opacity-100 transition-colors active:bg-secondary active:text-foreground',
        }}
        style={dragOffsetY !== 0 ? { transform: `translateY(${Math.max(0, dragOffsetY)}px)` } : undefined}
        className={cn(
          'fixed inset-x-0 bottom-0 top-auto left-0 right-0 flex max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-t-[20px] rounded-b-none border-x-0 border-b-0 border-t border-border/80 bg-popover p-0 text-popover-foreground shadow-2xl motion-reduce:transition-none',
          dragOffsetY === 0
            ? 'transition-[height,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]'
            : 'transition-none',
          expanded ? 'h-[92dvh]' : 'h-[74dvh]',
        )}
      >
        {/* 顶部拖拽区：微拉条 + 顶栏（支持上拉全屏 / 下拉收起或关闭） */}
        <div
          className="shrink-0 touch-none select-none"
          onTouchStart={onDragStart}
          onTouchMove={onDragMove}
          onTouchEnd={onDragEnd}
          onTouchCancel={onDragEnd}
        >
          <div className="flex justify-center pt-2.5 pb-1">
            <span aria-hidden="true" className="h-1 w-9 rounded-full bg-muted-foreground/30" />
          </div>

          <div className="flex items-center justify-between gap-2 pl-4 pr-12 pb-2">
            <DialogTitle className="text-base font-semibold tracking-tight text-foreground">工作区产出</DialogTitle>
            <button
              type="button"
              aria-label={expanded ? '收起为半屏' : '展开为全屏'}
              onClick={() => setExpanded((value) => !value)}
              className="inline-flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors active:bg-secondary active:text-foreground"
            >
              {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </button>
          </div>
        </div>

        {/* 动态 Segmented Tabs */}
        {sections.length > 0 && (
          <div
            role="tablist"
            aria-label="工作区产出分类"
            className="no-scrollbar flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--surface-hairline)] px-4 pb-2.5"
          >
            {sections.map((section) => {
              const Icon = TAB_ICONS[section.id]
              const selected = resolved?.id === section.id
              return (
                <button
                  key={section.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => onTabChange(section.id)}
                  className={cn(
                    'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium transition-colors',
                    selected
                      ? 'bg-secondary text-foreground shadow-2xs'
                      : 'text-muted-foreground active:bg-secondary/60 active:text-foreground',
                  )}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span>{section.label}</span>
                  {section.badge !== undefined && section.badge > 0 && (
                    <span className="rounded-full bg-foreground/10 px-1.5 text-[10px] tabular-nums">
                      {section.badge}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {/* 主内容区 */}
        <div
          role="tabpanel"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-y-contain pb-[env(safe-area-inset-bottom)]"
        >
          {resolved ? (
            resolved.content
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              当前会话暂无计划、变更或来源附件
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
