import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Globe,
  Grid2X2,
  Layers,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  X,
} from 'lucide-react'
import { ErrorBoundary } from '@pi-meme/ui/components/error-boundary'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import type { UiContributionProps, UiPanel, UiTarget } from '@pi-meme/plugin-sdk/ui'
import type { RegisteredNavigation } from '@pi-meme/plugin-sdk/navigation'
import { AppRail } from './app-rail'
import { PageHeader } from './page-header'
import { useSidebarFlyout } from './sidebar-flyout'
import type { UserProfile } from '../settings/user-profile'
import { useShortcutHandlers, useShortcuts } from '../shortcuts/shortcut-provider'
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
  activity,
  props,
  session,
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
  profile,
  profileLoading,
  onSettings,
  onUsage,
  onAccount,
  onNewSession,
  onPlugins,
  onProjects,
  pluginNavigation,
  onPlugin,
  shortcutEnabled = true,
  onShortcutHelp,
  children,
}: {
  panels: UiPanel[]
  activity?: { count: number; known: boolean }
  props: UiContributionProps
  session: string
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
  profile: UserProfile
  profileLoading: boolean
  onSettings?: () => void
  onUsage?: () => void
  onAccount?: () => void
  onNewSession?: () => void
  onPlugins?: () => void
  onProjects?: () => void
  pluginNavigation?: readonly RegisteredNavigation[]
  onPlugin?: (entry: RegisteredNavigation) => void
  shortcutEnabled?: boolean
  onShortcutHelp?: () => void
  children: ReactNode
}) {
  const storageKey = panelStorageKey(props.target.hostId, session)
  const readLayout = (): PanelLayoutState | undefined => {
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (raw === null) return undefined
      // 损坏或旧版本存档按“无存档”处理，避免用默认布局覆盖原记录。
      if ((JSON.parse(raw) as { version?: unknown }).version !== 2) return undefined
      return readPanelLayout(raw)
    } catch {
      return undefined
    }
  }
  const [state, updateState] = useState(() => {
    const saved = readLayout()
    return {
      storageKey,
      retainActivity: false,
      // inherited 表示当前布局沿用自其他会话，尚未写入本会话存档。
      inherited: saved === undefined,
      layout: saved ?? defaultPanelLayout(),
    }
  })
  const [search, setSearch] = useState('')
  if (state.storageKey !== storageKey) {
    // 新会话没有存档时沿用当前布局，切换会话不收起右栏或重置宽度。
    const saved = readLayout()
    updateState({ storageKey, retainActivity: false, inherited: saved === undefined, layout: saved ?? state.layout })
    setSearch('')
  }
  const layout = state.layout
  const setLayout = useCallback((update: (value: PanelLayoutState) => PanelLayoutState) => {
    updateState((value) => ({ ...value, inherited: false, layout: update(value.layout) }))
  }, [])
  const container = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(1280)
  const tabList = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => {
      if (element.clientWidth > 0) setContainerWidth(element.clientWidth)
    }
    const observer = new ResizeObserver(measure)
    measure()
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    // 沿用的布局不写入新会话，避免把上一会话的标签和宽度固化成新会话初始值。
    if (state.inherited) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(layout))
    } catch {
      /* 浏览器禁用存储时仍可使用标签页。 */
    }
  }, [state.inherited, storageKey, layout])
  const activityId = 'builtin:activities'
  const activityTabVisible = !activity || activity.count > 0 || !activity.known || state.retainActivity
  const available = panels.filter(
    (panel) => panelAvailable(panel, props.target) && (panel.id !== activityId || activityTabVisible),
  )
  const open = useCallback((id: string) => {
    setSearch('')
    updateState((value) => ({
      ...value,
      inherited: false,
      retainActivity: value.retainActivity || id === 'builtin:activities',
      layout: openPanel(value.layout, id),
    }))
  }, [])
  useEffect(() => {
    if (!activity || state.storageKey !== storageKey) return
    if (activity.count > 0 && layout.open && layout.tabs.includes(activityId) && !state.retainActivity) {
      updateState((value) => ({ ...value, retainActivity: true }))
    } else if (activity.known && activity.count === 0 && !state.retainActivity && layout.tabs.includes(activityId)) {
      setLayout((value) => closePanel(value, activityId))
    }
  }, [activity?.count, activity?.known, layout, state.retainActivity, state.storageKey, storageKey, setLayout])
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
  const maxWidth = Math.max(0, workspaceWidth - Math.min(480, containerWidth * 0.6))
  const rightWidth = Math.min(layout.expanded ? maxWidth : layout.width, maxWidth)
  const bothPanesFit = containerWidth - sidebarWidth >= 480 + 280
  useEffect(() => {
    if (sidebarOpen && containerWidth - sidebarWidth < 320) onSidebar(false, sidebarWidth)
  }, [containerWidth, sidebarOpen, sidebarWidth, onSidebar])
  useEffect(() => {
    if (layout.open && sidebarOpen && !bothPanesFit) onSidebar(false, sidebarWidth)
  }, [layout.open, sidebarOpen, bothPanesFit, sidebarWidth, onSidebar])
  const changeSidebar = (open: boolean, width: number) => {
    if (open && containerWidth - width < 480 + 280) setLayout((value) => ({ ...value, open: false }))
    onSidebar(open, width)
  }
  const toggleSidebar = () => changeSidebar(!sidebarOpen, sidebarWidth)
  const reducedMotion = useReducedMotion()
  const leftPane = usePaneMotion(sidebarOpen, sidebarWidth, reducedMotion)
  const rightPane = usePaneMotion(layout.open, rightWidth, reducedMotion)

  // 折叠态首页悬停浮层：固定侧栏完全收起后才挂载，避免同时渲染两份会话列表。
  const flyout = useSidebarFlyout({ enabled: !sidebarOpen && !leftPane.mounted, reduceMotion: reducedMotion })
  const flyoutWidth = Math.min(sidebarWidth, Math.max(160, containerWidth - 16))
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
  const shortcuts = useShortcuts()
  const toolsShortcut = shortcuts.getShortcutLabel('toggleTools')

  useShortcutHandlers(
    {
      toggleSidebar,
      toggleTools: toggleRight,
    },
    shortcutEnabled,
  )
  const filtered = available.filter(
    (panel) =>
      (panel.id !== activityId || !activity || activity.count > 0) &&
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
      data-motion={directMotion ? 'direct' : 'slide'}
      data-pane-sidebar={sidebarOpen ? 'open' : 'closed'}
      data-pane-right={layout.open ? 'open' : 'closed'}
      data-overscroll={overscroll}
      style={shellStyle}
      className="workspace-panes flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-secondary"
    >
      {/* 顶部栏：位于最外层外框中，与最左侧 ICON 栏同底色 */}
      <PageHeader>
        <div className="workspace-main-header flex h-full min-w-0 overflow-hidden bg-transparent window-drag">
          {header(toggleSidebar)}
        </div>
        {rightPane.mounted && (
          <div
            className="right-pane relative flex h-full shrink-0 overflow-hidden bg-transparent window-drag"
            style={{ width: 'var(--workspace-right-width)' }}
            data-testid="right-panel-header"
          >
            {/* 与下方右侧栏左边缘严格对齐的短竖向分割线，折叠时隐藏 */}
            {layout.open && <div className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-px bg-white/15 shrink-0" />}
            {/* 内容靠右钉住。栏宽拉开时从左侧露出，而不是等宽度到位后整组冒出来。 */}
            <div
              className="pane-clip flex h-full w-full items-center justify-between pl-3 pr-2"
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
                  const title = panel?.title ?? '工具'
                  return (
                    <div
                      key={id}
                      className={`group flex min-w-0 shrink-0 items-center rounded-md ${active === id ? 'bg-background/80 text-foreground shadow-xs' : 'text-muted-foreground hover:bg-background/40'}`}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active === id}
                        aria-controls="right-tool-content"
                        tabIndex={active === id ? 0 : -1}
                        onClick={() => setLayout((value) => ({ ...value, active: id }))}
                        className="flex h-7 min-w-0 items-center gap-1.5 pl-2.5 pr-1 text-xs"
                        title={title}
                      >
                        <span className="flex size-3.5 shrink-0 items-center justify-center [&>svg]:size-3.5">
                          {panel?.icon ?? <Grid2X2 />}
                        </span>
                        <span className="max-w-28 truncate">{title}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`关闭标签页：${title}`}
                        className="mr-1 inline-flex items-center rounded p-1 text-muted-foreground opacity-0 pointer-events-none transition-opacity duration-200 ease-out hover:bg-background/60 hover:text-foreground group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() =>
                          updateState((value) => ({
                            ...value,
                            inherited: false,
                            retainActivity: id === activityId ? false : value.retainActivity,
                            layout: closePanel({ ...value.layout, tabs, active }, id),
                          }))
                        }
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center gap-1 shrink-0 no-drag ml-auto">
                <HeaderButton label="新建工具标签页" onClick={() => open(toolsTabId)}>
                  <Plus />
                </HeaderButton>
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
        <div className="absolute inset-y-0 right-3 z-10 flex items-center no-drag">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleRight}
                aria-label={layout.open ? '收起右侧栏' : '展开右侧栏'}
                aria-expanded={layout.open}
                aria-controls="workspace-right-sidebar"
                className="relative size-7 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                {layout.open ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
                {Boolean(activity?.count) && (
                  <span
                    aria-label={`${activity!.count} 个活动服务`}
                    className="absolute -right-1 -top-1 min-w-3.5 rounded-full bg-primary px-0.5 text-[9px] leading-3.5 text-primary-foreground tabular-nums"
                  >
                    {activity!.count}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {activity?.count
                ? `本会话有 ${activity.count} 个活动服务${toolsShortcut ? ` · ${toolsShortcut}` : ''}`
                : layout.open
                  ? `收起右侧栏${toolsShortcut ? ` · ${toolsShortcut}` : ''}`
                  : `展开右侧栏${toolsShortcut ? ` · ${toolsShortcut}` : ''}`}
            </TooltipContent>
          </Tooltip>
        </div>
      </PageHeader>

      {/* 顶部栏下方：最左侧为 AppRail，右侧为圈起来的圆角内容框体 */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* 最左侧：AppRail（与顶部外框同色） */}
        <AppRail
          profile={profile}
          profileLoading={profileLoading}
          pluginNavigation={pluginNavigation}
          onPlugin={onPlugin}
          homeActive
          onHome={() => {
            // 首页入口开新会话，浮层里旧的会话列表不必继续悬在正文上。
            flyout.close()
            onNewSession?.()
          }}
          homeFlyout={flyout.control}
          onProjects={onProjects}
          onPlugins={onPlugins}
          onSettings={onSettings}
          onUsage={onUsage}
          onAccount={onAccount}
          onShortcutHelp={onShortcutHelp}
        />

        {/* 内容部分：被有圆角框体圈起来的 3 部分容器（四角全圆角，右侧与底部留外框边距，复刻 Codex 设计） */}
        <div ref={container} className="content-frame relative bg-background">
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
                className="appearance-sidebar flex min-h-0 w-full flex-col overflow-hidden bg-card/40"
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
                    changeSidebar(!result.collapse, result.collapse ? sidebarWidth : result.width)
                  }}
                />
              )}
            </div>
          )}
          <div id="chat-workspace" className="theme-workspace flex min-h-0 min-w-0 flex-1 flex-col bg-background">
            {children}
          </div>
          {rightPane.mounted && (
            <div
              className="right-pane relative flex shrink-0 border-l border-white/10"
              style={{ width: 'var(--workspace-right-width)' }}
            >
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
                className="flex min-h-0 w-full flex-col overflow-hidden bg-card/40"
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
                  aria-label={selected?.title ?? '工具'}
                  className="pane-clip flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden @container"
                  style={{ width: rightPane.dragging ? '100%' : rightWidth }}
                >
                  {selected ? (
                    <ErrorBoundary
                      key={`${storageKey}:${selected.id}:${selected.generation ?? 0}`}
                      fallbackTitle={`面板渲染失败：${selected.title}`}
                    >
                      <PanelContent panel={selected} props={props} />
                    </ErrorBoundary>
                  ) : (
                    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                      <div className="flex items-center gap-1.5 px-3 py-2">
                        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-secondary/50 px-3 py-1 text-xs text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
                          <Search className="size-3.5 shrink-0 text-muted-foreground" />
                          <input
                            aria-label="查找工具和插件"
                            placeholder="查找工具和插件"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                          />
                        </label>
                      </div>
                      <div className="p-4 @container">
                        <h2 className="mb-4 text-sm font-medium text-foreground">工具</h2>
                        <div className="grid grid-cols-1 gap-2 @min-[32rem]:grid-cols-2 @min-[32rem]:gap-x-3">
                          {filtered.map((panel) => (
                            <button
                              key={panel.id}
                              type="button"
                              onClick={() => open(panel.id)}
                              className="group flex min-h-10 min-w-0 items-center rounded-lg bg-secondary/40 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
                            >
                              <div className="flex min-w-0 items-center gap-3">
                                <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground group-hover:text-foreground [&>svg]:size-4">
                                  {panel.icon}
                                </span>
                                <span className="truncate">{panel.title}</span>
                              </div>
                            </button>
                          ))}
                        </div>
                        {!filtered.length && (
                          <p className="py-4 text-xs text-muted-foreground">
                            {search ? '没有匹配的工具。' : '当前聊天暂无可用工具。可在插件页面安装工具插件。'}
                          </p>
                        )}
                        <div className="mt-5">
                          <h2 className="mb-2.5 text-xs font-medium text-muted-foreground/80">推荐</h2>
                          <div className="grid grid-cols-1 gap-2 @min-[32rem]:grid-cols-2 @min-[32rem]:gap-x-3">
                            <button
                              type="button"
                              onClick={onNewSession}
                              disabled={!onNewSession}
                              className="group flex min-h-10 min-w-0 items-center gap-3 rounded-lg bg-secondary/40 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Globe className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
                              <span className="truncate">新会话</span>
                            </button>
                            <button
                              type="button"
                              onClick={onPlugins}
                              disabled={!onPlugins}
                              className="group flex min-h-10 min-w-0 items-center gap-3 rounded-lg bg-secondary/40 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Layers className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
                              <span className="truncate">扩展中心</span>
                            </button>
                          </div>
                        </div>
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

          {/* 折叠态首页悬停浮层：贴在聊天框体内侧，四边等距留白，不挤压正文。 */}
          {flyout.mounted && (
            <div
              ref={flyout.panelRef}
              id="workspace-sidebar-flyout"
              data-state={flyout.visible ? 'open' : 'closed'}
              aria-hidden={!flyout.visible}
              className="absolute inset-2 z-30 flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-md data-[state=closed]:pointer-events-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:fill-mode-forwards duration-150 motion-reduce:animate-none"
              style={{ width: flyoutWidth }}
              {...flyout.panelProps}
            >
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{sidebar}</div>
            </div>
          )}
        </div>
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
