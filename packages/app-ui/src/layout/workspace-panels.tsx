import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Grid2X2, Maximize2, Minimize2, PanelRightClose, PanelRightOpen, Plus, Search, X } from 'lucide-react'
import { ErrorBoundary } from '@pi-meme/ui/components/error-boundary'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import type { UiContributionProps, UiPanel, UiTarget } from '@pi-meme/plugin-sdk/ui'
import {
  closePanel,
  defaultPanelLayout,
  openPanel,
  panelAvailable,
  panelStorageKey,
  readPanelLayout,
  toolsTabId,
  type PanelLayoutState,
} from './panel-layout'
import { usePaneMotion, useReducedMotion } from './pane-motion'
import { ResizeHandle } from './resize-handle'

export function WorkspacePanels({
  panels,
  props,
  session,
  runtimeSession,
  requestPanel,
  onPanelRequestHandled,
  errors = {},
  requestRight,
  requestRightToken,
  onRightRequestHandled,
  sidebar,
  sidebarOpen,
  sidebarWidth,
  onSidebar,
  header,
  children,
}: {
  panels: UiPanel[]
  props: UiContributionProps
  session: string
  runtimeSession?: string
  errors?: Record<string, string>
  requestPanel?: { id: string; revision: number; target: UiTarget } | null
  onPanelRequestHandled?: (revision: number) => void
  requestRight?: string
  requestRightToken?: string
  onRightRequestHandled?: () => void
  sidebar: ReactNode
  sidebarOpen: boolean
  sidebarWidth: number
  onSidebar: (open: boolean, width: number) => void
  header: (toggleSidebar: () => void) => ReactNode
  children: ReactNode
}) {
  const storageKey = panelStorageKey(props.target.hostId, session)
  const scope = panelStorageKey(props.target.hostId, runtimeSession ?? session)
  const readLayout = () => {
    try {
      return readPanelLayout(window.localStorage.getItem(storageKey))
    } catch {
      return defaultPanelLayout()
    }
  }
  const [state, updateState] = useState(() => ({
    scope,
    storageKey,
    modified: false,
    layout: readLayout(),
  }))
  const [search, setSearch] = useState('')
  if (state.scope !== scope) {
    updateState({ scope, storageKey, modified: false, layout: readLayout() })
    setSearch('')
  } else if (state.storageKey !== storageKey) {
    updateState({ ...state, storageKey, layout: state.modified ? state.layout : readLayout() })
  }
  const layout = state.layout
  const setLayout = useCallback((update: (value: PanelLayoutState) => PanelLayoutState) => {
    updateState((value) => ({ ...value, modified: true, layout: update(value.layout) }))
  }, [])
  const container = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(1280)
  const tabList = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(() => setContainerWidth(element.clientWidth))
    setContainerWidth(element.clientWidth)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(layout))
    } catch {
      /* 浏览器禁用存储时仍可使用标签页。 */
    }
  }, [storageKey, layout])
  const available = panels.filter((panel) => panelAvailable(panel, props.target))
  const open = useCallback((id: string) => {
    setSearch('')
    setLayout((value) => openPanel(value, id))
  }, [])
  useEffect(() => {
    if (requestRight && panels.some((panel) => panel.id === requestRight && panelAvailable(panel, props.target))) {
      open(requestRight)
      onRightRequestHandled?.()
    }
  }, [requestRight, requestRightToken, open, onRightRequestHandled, panels, props.target])
  useEffect(() => {
    if (
      requestPanel &&
      requestPanel.target.hostId === props.target.hostId &&
      requestPanel.target.session?.sessionId === props.target.session?.sessionId &&
      requestPanel.target.project?.projectId === props.target.project?.projectId &&
      panels.some((panel) => panel.id === requestPanel.id && panelAvailable(panel, props.target))
    ) {
      open(requestPanel.id)
      onPanelRequestHandled?.(requestPanel.revision)
    }
  }, [requestPanel, open, panels, props.target, onPanelRequestHandled])
  useEffect(() => {
    tabList.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [layout.active, layout.open])
  const visibleTabs = layout.tabs.filter((id) => id === toolsTabId || available.some((panel) => panel.id === id))
  const tabs = visibleTabs.length ? visibleTabs : [toolsTabId]
  const active = tabs.includes(layout.active) ? layout.active : tabs[0]
  const selected = available.find((panel) => panel.id === active)
  const workspaceWidth = Math.max(0, containerWidth - (sidebarOpen ? sidebarWidth : 0))
  const maxWidth = Math.max(0, workspaceWidth - Math.min(320, workspaceWidth * 0.45))
  const rightWidth = Math.min(layout.expanded ? maxWidth : layout.width, maxWidth)
  const reducedMotion = useReducedMotion()
  const leftPane = usePaneMotion(sidebarOpen, sidebarWidth, reducedMotion)
  const rightPane = usePaneMotion(layout.open, rightWidth, reducedMotion)
  const [motionReady, setMotionReady] = useState(false)
  const containerRef = useRef(containerWidth)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMotionReady(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  // 只在窗口尺寸变化时取消过渡。折叠左栏也会改变右栏上限，不能因此把左栏宽度动画关掉。
  useLayoutEffect(() => {
    if (containerRef.current === containerWidth) return
    containerRef.current = containerWidth
    rightPane.jump()
  }, [containerWidth, rightPane.jump])
  const toggleRight = () => setLayout((value) => ({ ...value, open: !value.open }))
  const filtered = available.filter((panel) =>
    panel.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  )
  const directMotion =
    !motionReady || reducedMotion || leftPane.dragging || rightPane.dragging || leftPane.instant || rightPane.instant
  const overscroll = leftPane.overscroll ? 'sidebar' : rightPane.overscroll ? 'right' : undefined
  const shellStyle = {
    '--workspace-sidebar-width': `${leftPane.presented}px`,
    '--workspace-right-width': `${rightPane.presented}px`,
  } as CSSProperties

  return (
    <div
      ref={container}
      data-motion={directMotion ? 'direct' : 'slide'}
      data-pane-sidebar={sidebarOpen ? 'open' : 'closed'}
      data-pane-right={layout.open ? 'open' : 'closed'}
      data-overscroll={overscroll}
      style={shellStyle}
      className="workspace-panes flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="workspace-topbar relative z-30 flex h-11 shrink-0">
        <div className="workspace-main-header flex h-full min-w-0 overflow-hidden border-b border-border/70 bg-background/80 backdrop-blur-md window-drag select-none">
          {header(() => onSidebar(!sidebarOpen, sidebarWidth))}
        </div>
        {rightPane.mounted && (
          <div
            className="right-pane absolute inset-y-0 right-0 overflow-hidden border-b border-l border-border/70 bg-secondary/40 window-drag"
            style={{ width: 'var(--workspace-right-width)' }}
            data-testid="right-panel-header"
          >
            {/* 内容靠右钉住。栏宽拉开时从左侧露出，而不是等宽度到位后整组冒出来。 */}
            <div
              className="pane-clip absolute inset-y-0 right-0 flex items-center gap-1 pl-2"
              style={{ width: rightPane.dragging ? '100%' : rightWidth }}
            >
              <div
                ref={tabList}
                role="tablist"
                aria-label="右侧栏标签"
                className="flex min-w-0 items-center gap-1 overflow-x-auto no-drag"
                style={{ scrollbarWidth: 'none' }}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                  const index = tabs.indexOf(active)
                  const next =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
                  event.preventDefault()
                  setLayout((value) => ({ ...value, active: tabs[next] }))
                  tabList.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
                }}
              >
                {tabs.map((id) => {
                  const panel = available.find((entry) => entry.id === id)
                  const title = panel?.title ?? '新标签页'
                  return (
                    <div
                      key={id}
                      className={`group flex min-w-0 shrink-0 items-center rounded-lg border ${active === id ? 'border-border/70 bg-secondary text-foreground' : 'border-transparent text-muted-foreground hover:bg-secondary/60'}`}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active === id}
                        aria-controls="right-tool-content"
                        tabIndex={active === id ? 0 : -1}
                        onClick={() => setLayout((value) => ({ ...value, active: id }))}
                        className="flex h-8 min-w-0 items-center gap-2 pl-2.5 pr-1 text-xs"
                        title={title}
                      >
                        <span className="flex size-4 shrink-0 items-center justify-center [&>svg]:size-4">
                          {panel?.icon ?? <Grid2X2 />}
                        </span>
                        <span className="max-w-28 truncate">{title}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`关闭标签页：${title}`}
                        className="mr-1 inline-flex items-center rounded p-1 text-muted-foreground opacity-0 pointer-events-none transition-opacity duration-200 ease-out hover:bg-background/60 hover:text-foreground group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => setLayout((value) => closePanel({ ...value, tabs, active }, id))}
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  )
                })}
              </div>
              <HeaderButton label="新建工具标签页" onClick={() => open(toolsTabId)}>
                <Plus />
              </HeaderButton>
              <div className="ml-auto flex shrink-0 items-center gap-0.5 no-drag">
                <HeaderButton
                  label={layout.expanded ? '还原右侧栏宽度' : '加宽右侧栏'}
                  onClick={() => setLayout((value) => ({ ...value, expanded: !value.expanded }))}
                >
                  {layout.expanded ? <Minimize2 /> : <Maximize2 />}
                </HeaderButton>
              </div>
            </div>
          </div>
        )}
        {/* 开关盖在右栏右缘上，不单独占一列。 */}
        <div className="absolute inset-y-0 right-3 z-10 flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleRight}
                aria-label={layout.open ? '收起右侧栏' : '展开右侧栏'}
                aria-expanded={layout.open}
                className="no-drag size-7 text-muted-foreground hover:text-foreground"
              >
                {layout.open ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{layout.open ? '收起右侧栏' : '展开右侧栏'}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {leftPane.mounted && (
          <div
            className="sidebar-pane relative flex min-w-0 shrink-0 overflow-hidden"
            style={{ width: 'var(--workspace-sidebar-width)' }}
          >
            <aside
              id="workspace-sidebar"
              aria-label="会话导航"
              aria-hidden={!sidebarOpen}
              inert={!sidebarOpen}
              className="appearance-sidebar flex min-h-0 w-full flex-col overflow-hidden border-r border-border/70"
            >
              <div
                className="pane-clip flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                style={{
                  width: leftPane.dragging ? '100%' : sidebarWidth,
                  minWidth: leftPane.dragging ? undefined : sidebarWidth,
                }}
              >
                {sidebar}
              </div>
            </aside>
            {sidebarOpen && (
              <ResizeHandle
                side="left"
                width={leftPane.presented}
                min={200}
                max={420}
                onDragStart={leftPane.beginDrag}
                onDrag={leftPane.dragTo}
                onDragEnd={(result) => {
                  leftPane.endDrag(result)
                  onSidebar(!result.collapse, result.collapse ? sidebarWidth : result.width)
                }}
              />
            )}
          </div>
        )}
        <div id="chat-workspace" className="theme-workspace flex min-h-0 min-w-0 flex-1 flex-col">
          {children}
        </div>
        {rightPane.mounted && (
          <div className="right-pane relative flex shrink-0" style={{ width: 'var(--workspace-right-width)' }}>
            {layout.open && (
              <ResizeHandle
                side="right"
                width={rightPane.presented}
                min={Math.min(280, maxWidth)}
                max={maxWidth}
                onDragStart={rightPane.beginDrag}
                onDrag={rightPane.dragTo}
                onDragEnd={(result) => {
                  rightPane.endDrag(result)
                  setLayout((value) =>
                    result.collapse
                      ? { ...value, open: false }
                      : { ...value, open: true, width: result.width, expanded: false },
                  )
                }}
              />
            )}
            <aside
              id="workspace-right-sidebar"
              aria-label="右侧栏"
              aria-hidden={!layout.open}
              inert={!layout.open}
              className="flex min-h-0 w-full flex-col overflow-hidden border-l border-border/70 bg-background"
              onKeyDown={(event) => {
                if (
                  event.key !== 'Escape' ||
                  event.defaultPrevented ||
                  (event.target as HTMLElement).closest('[role="dialog"]')
                )
                  return
                event.stopPropagation()
                setLayout((value) => ({ ...value, open: false }))
              }}
            >
              <div
                id="right-tool-content"
                role="tabpanel"
                aria-label={selected?.title ?? '新标签页'}
                className="pane-clip flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden @container"
                style={{ width: rightPane.dragging ? '100%' : rightWidth }}
              >
                {selected ? (
                  <ErrorBoundary
                    key={`${scope}:${selected.id}:${selected.generation ?? 0}`}
                    fallbackTitle={`面板渲染失败：${selected.title}`}
                  >
                    <PanelContent panel={selected} props={props} />
                  </ErrorBoundary>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                    <div className="border-b border-border/60 px-4 py-3">
                      <label className="flex items-center gap-2 rounded-full bg-secondary/70 px-3 py-2 text-muted-foreground">
                        <Search className="size-4 shrink-0" />
                        <input
                          aria-label="查找工具和插件"
                          placeholder="查找工具和插件"
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                        />
                      </label>
                    </div>
                    <div className="p-5 @container">
                      <h2 className="mb-4 text-xs font-medium">工具</h2>
                      <div className="grid grid-cols-1 gap-2 @min-[400px]:grid-cols-2">
                        {filtered.map((panel) => (
                          <button
                            key={panel.id}
                            type="button"
                            onClick={() => open(panel.id)}
                            className="flex min-w-0 items-center gap-3 rounded-lg bg-secondary/40 px-4 py-3.5 text-left text-sm transition-colors hover:bg-secondary/80"
                          >
                            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-4">
                              {panel.icon}
                            </span>
                            <span className="truncate">{panel.title}</span>
                          </button>
                        ))}
                      </div>
                      {!filtered.length && (
                        <p className="py-4 text-xs text-muted-foreground">
                          {search ? '没有匹配的工具。' : '当前聊天暂无可用工具。可在插件页面安装工具插件。'}
                        </p>
                      )}
                      {Object.entries(errors).map(([id, error]) => (
                        <p key={id} role="alert" className="mt-3 break-words text-xs text-destructive">
                          {id}：{error}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  )
}

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground no-drag [&>svg]:size-4"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

function PanelContent({ panel, props }: { panel: UiPanel; props: UiContributionProps }) {
  return <>{panel.render(props)}</>
}
