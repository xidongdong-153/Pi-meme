import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { PanelLeft } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'
import { useShortcutHandlers, useShortcuts } from '../shortcuts/shortcut-provider'
import { usePaneMotion, useReducedMotion } from './pane-motion'
import { ResizeHandle } from './resize-handle'
import { useSidebarFlyout } from './sidebar-flyout'
import { sidebarMaxWidth, sidebarMinWidth, type SidebarLayout } from './use-sidebar-layout'

export function useSidebarContainer() {
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1280)
  useEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => {
      if (element.clientWidth > 0) setWidth(element.clientWidth)
    }
    const observer = new ResizeObserver(measure)
    measure()
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { container, width }
}

/** 布局由客户端持有；每个页面只管理自己的动画、浮层与焦点。 */
export function useWorkspaceSidebar({
  layout,
  containerWidth,
  visible = true,
  shortcutEnabled = visible,
}: {
  layout: SidebarLayout
  containerWidth: number
  visible?: boolean
  shortcutEnabled?: boolean
}) {
  const { open, width, change } = layout
  const contentId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const reducedMotion = useReducedMotion()
  const pane = usePaneMotion(open, width, reducedMotion)
  const flyout = useSidebarFlyout({
    enabled: visible && !open,
    ready: !pane.mounted,
    reduceMotion: reducedMotion,
    contentId,
    toggleRef,
  })
  const [motionReady, setMotionReady] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMotionReady(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  useEffect(() => {
    if (visible && open && containerWidth - width < 320) change(false, width)
  }, [visible, open, containerWidth, width, change])
  useLayoutEffect(() => {
    if (!visible || open || !flyout.panelRef.current?.contains(document.activeElement)) return
    toggleRef.current?.focus()
  }, [visible, open, flyout.panelRef])
  const toggle = () => {
    if (flyout.open) flyout.close()
    else if (!open && containerWidth - width < 320) flyout.control?.onKeyboardOpen()
    else change(!open, width)
  }
  useShortcutHandlers({ toggleSidebar: toggle }, visible && shortcutEnabled)

  return {
    open,
    width,
    change,
    toggle,
    toggleRef,
    contentId,
    containerWidth,
    visible,
    reducedMotion,
    pane,
    flyout,
    directMotion: !motionReady || reducedMotion || pane.dragging || pane.instant,
    style: { '--workspace-sidebar-width': `${pane.presented}px` } as CSSProperties,
  }
}

export type WorkspaceSidebarState = ReturnType<typeof useWorkspaceSidebar>

export function SidebarToggle({
  sidebar,
}: {
  sidebar: Pick<WorkspaceSidebarState, 'open' | 'toggle' | 'toggleRef' | 'contentId' | 'flyout'>
}) {
  const shortcuts = useShortcuts()
  const shortcut = shortcuts.getShortcutLabel('toggleSidebar')
  const expanded = sidebar.open || sidebar.flyout.open
  const label = expanded ? '收起侧边栏' : '展开侧边栏'
  return (
    <TooltipHint content={`${label}${shortcut ? ` · ${shortcut}` : ''}`} side="bottom">
      <Button
        ref={sidebar.toggleRef}
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-expanded={expanded}
        aria-controls={sidebar.contentId}
        onClick={sidebar.toggle}
        className="no-drag size-7 shrink-0 text-muted-foreground hover:text-foreground"
      >
        <PanelLeft className="size-4" />
      </Button>
    </TooltipHint>
  )
}

/** 同一份内容在固定侧栏与悬停浮层之间切换，收起后保留表单和滚动状态。 */
export function WorkspaceSidebar({
  sidebar,
  label,
  children,
}: {
  sidebar: WorkspaceSidebarState
  label: string
  children: ReactNode
}) {
  const { open, width, change, contentId, containerWidth, visible, pane, flyout } = sidebar
  const docked = pane.mounted
  const shown = visible && (docked ? open : flyout.visible)
  return (
    <div
      ref={flyout.panelRef}
      data-state={shown ? 'open' : 'closed'}
      aria-hidden={!shown}
      inert={!shown}
      className={cn(
        'flex min-h-0 min-w-0 shrink-0 flex-col',
        docked
          ? 'sidebar-pane relative border-r border-border/60'
          : 'absolute inset-y-2 left-2 z-30 overflow-hidden rounded-xl border border-border bg-card shadow-md data-[state=closed]:pointer-events-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:fill-mode-forwards duration-150 motion-reduce:animate-none',
      )}
      style={{
        width: docked ? 'var(--workspace-sidebar-width)' : Math.min(width, Math.max(0, containerWidth - 16)),
        display: !docked && !flyout.mounted ? 'none' : undefined,
      }}
      {...(!docked ? flyout.panelProps : {})}
    >
      <aside
        id={contentId}
        aria-label={label}
        className="appearance-sidebar flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-card/40"
      >
        <div
          className="pane-clip flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          style={{
            width: docked && !pane.dragging ? width : '100%',
            minWidth: docked && !pane.dragging ? width : undefined,
          }}
        >
          {children}
        </div>
      </aside>
      {docked && open && visible && (
        <ResizeHandle
          side="left"
          width={pane.presented}
          min={sidebarMinWidth}
          max={Math.min(sidebarMaxWidth, Math.max(sidebarMinWidth, containerWidth - 320))}
          onDragStart={pane.beginDrag}
          onDrag={pane.dragTo}
          onDragCancel={pane.cancelDrag}
          onDragEnd={(result) => {
            pane.endDrag(result)
            change(!result.collapse, result.collapse ? width : result.width)
          }}
        />
      )}
    </div>
  )
}
