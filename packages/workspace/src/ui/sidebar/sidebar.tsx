import { SidebarMenus, type SidebarMenuBridge } from './sidebar-menus'
import type { SettingsBridge, WorkspaceBridge, WorkspaceDeletionResult } from '@pi-meme/contracts/desktop'
import { useEffect, useMemo, useState } from 'react'
import { Bell, ChevronDown, Search, SquarePen } from 'lucide-react'
import type { PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import { Button } from '@pi-meme/ui/components/ui/button'
import { buildSidebarModel, sidebarManualOrders } from './sidebar-model'
import { SidebarPreferencesMenu } from './sidebar-controls'
import { SessionSearchDialog } from './session-search-dialog'
import { useSidebarManualOrders, useSidebarPreferences } from './use-sidebar-preferences'
import { PinnedSection } from './pinned-section'
import { ProjectsSection } from './projects-section'
import { RecentsSection } from './recents-section'

export type SidebarProps = {
  serviceId?: string
  searchEnabled?: boolean
  searchHistory?: WorkspaceBridge['searchSessions']
  sidebarSettingsBridge?: Pick<SettingsBridge, 'getSettings' | 'saveSidebarPreferences'>
  onSelectProject: (cwd: string) => void
  menuBridge: SidebarMenuBridge
  onMenuChanged: () => Promise<void>
  onMenuDeleted: (result: WorkspaceDeletionResult) => Promise<void>
  projectName: string
  cwd: string
  ready: boolean
  status: string
  /** Desktop 内置 Pi 运行时版本 */
  piVersion?: string
  sessionsSnapshot: PiSessionsSnapshot | null
  sessionsLoading: boolean
  activeSessionId?: string
  activeSessionPath?: string
  /** 切换会话期间的乐观目标路径，用于立即高亮 */
  switchingToPath?: string | null
  onCollapse?: () => void
  onDirectory: () => void
  onNewSession: () => void
  onNewSessionInProject: (targetCwd: string) => void
  onSwitchSession: (sessionPath: string) => void
  onTogglePin: (targetPath: string) => void
  onPrefetchSession: (sessionPath: string) => void
  onSettings: () => void
}

export function Sidebar({
  serviceId = 'local',
  searchEnabled = true,
  searchHistory: loadSessionMatches,
  sidebarSettingsBridge,
  menuBridge,
  onMenuChanged,
  onMenuDeleted,
  projectName: _projectName,
  cwd,
  ready,
  status,
  sessionsSnapshot,
  sessionsLoading,
  activeSessionId,
  activeSessionPath,
  switchingToPath,
  onCollapse: _onCollapse,
  onDirectory,
  onNewSession,
  onNewSessionInProject,
  onSwitchSession,
  onTogglePin,
  onPrefetchSession,
  onSettings,
}: SidebarProps) {
  // 切换中使用乐观路径，否则使用实际路径
  const effectiveActivePath = switchingToPath ?? activeSessionPath
  const [searchOpen, setSearchOpen] = useState(false)
  const searchHistory = useMemo(
    () =>
      loadSessionMatches
        ? (_serviceId: string, query: string, paths: string[]) => loadSessionMatches(query, paths)
        : undefined,
    [loadSessionMatches],
  )
  const { preferences, loaded, error, save } = useSidebarPreferences(
    sidebarSettingsBridge,
    Boolean(sidebarSettingsBridge),
  )
  const model = useMemo(
    () => buildSidebarModel(sessionsSnapshot ? [{ serviceId, snapshot: sessionsSnapshot }] : [], preferences),
    [sessionsSnapshot, serviceId, preferences],
  )
  useSidebarManualOrders(model, preferences, loaded, save)
  useEffect(() => {
    if (!searchEnabled) return
    const handleKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.isComposing &&
        event.key.toLowerCase() === 'k' &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault()
        setSearchOpen(true)
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [searchEnabled])
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [recentsLimit, setRecentsLimit] = useState(8)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set([cwd]))
  const [expandedProjectItemLimits, setExpandedProjectItemLimits] = useState<Set<string>>(() => new Set())

  const toggleProject = (targetCwd: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(targetCwd)) {
        next.delete(targetCwd)
      } else {
        next.add(targetCwd)
      }
      return next
    })
  }

  const toggleProjectItems = (targetCwd: string) => {
    setExpandedProjectItemLimits((prev) => {
      const next = new Set(prev)
      if (next.has(targetCwd)) {
        next.delete(targetCwd)
      } else {
        next.add(targetCwd)
      }
      return next
    })
  }

  const pinnedSet = new Set(sessionsSnapshot?.pinnedPaths ?? [])
  const openNewSession = (targetCwd: string) => {
    setExpandedProjects((prev) => new Set(prev).add(targetCwd))
    onNewSessionInProject(targetCwd)
  }

  const projectProps = {
    cwd,
    pinnedSet,
    activeSessionId,
    activeSessionPath: effectiveActivePath,
    onNewSessionInProject: openNewSession,
    onSwitchSession,
    onTogglePin,
    onPrefetchSession,
  }
  const sortable = preferences.sortMode === 'manual'
  const onReorderSessions = (listKey: string, keys: string[]) => {
    void save({ orders: { [listKey]: keys } })
  }
  const preferencesMenu = (
    <SidebarPreferencesMenu
      preferences={preferences}
      disabled={!loaded}
      onChange={(patch) =>
        void save(
          patch.sortMode === 'manual' ? { ...patch, orders: sidebarManualOrders(model, preferences.orders) } : patch,
        )
      }
    />
  )

  return (
    <SidebarMenus
      bridge={menuBridge}
      pinnedPaths={sessionsSnapshot?.pinnedPaths ?? []}
      onNewSession={openNewSession}
      onTogglePin={onTogglePin}
      onChanged={onMenuChanged}
      onDeleted={onMenuDeleted}
    >
      <aside
        className="appearance-sidebar flex h-full w-full flex-col bg-card/60 backdrop-blur-md select-none shrink-0"
        aria-label="侧边栏"
      >
        {/* 侧边栏顶部品牌与搜索 */}
        <div className="flex h-10 items-center justify-between px-3 shrink-0">
          <button
            type="button"
            onClick={onDirectory}
            aria-label="切换项目目录"
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold text-foreground/90 hover:bg-secondary/60 transition-colors cursor-pointer"
          >
            <span>pi-meme</span>
            <ChevronDown className="size-3 text-muted-foreground/60" />
          </button>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="通知"
              title="暂无新通知"
              className="size-7 text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <Bell className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="搜索聊天"
              title="搜索聊天（⌘K / Ctrl+K）"
              onClick={() => setSearchOpen(true)}
              className="size-7 text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <Search className="size-3.5" />
            </Button>
          </div>
        </div>

        {/* 新聊天入口 */}
        <div className="px-3 py-1.5">
          <button
            type="button"
            onClick={onNewSession}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium text-foreground transition-colors duration-200 ease-out hover:bg-secondary/70 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer text-left group"
          >
            <SquarePen className="size-4 text-foreground/80 shrink-0 group-hover:text-primary transition-colors" />
            <span>新聊天</span>
          </button>
        </div>

        {/* 滚动区域：未连接占位 vs 置顶、项目与最近列表 */}
        <div className="flex-1 min-h-0 overflow-x-hidden overflow-y-auto pl-3 pr-1.5 [scrollbar-gutter:stable]">
          {!ready && !sessionsSnapshot ? (
            status === '连接中' ? (
              <div className="space-y-4 py-3 px-1 animate-pulse">
                <div className="space-y-2">
                  <div className="h-3 w-10 bg-secondary/80 rounded" />
                  <div className="h-7 w-full bg-secondary/40 rounded-lg" />
                </div>
                <div className="space-y-2 pt-2">
                  <div className="h-3 w-10 bg-secondary/80 rounded" />
                  <div className="h-7 w-full bg-secondary/40 rounded-lg" />
                  <div className="h-7 w-full bg-secondary/30 rounded-lg" />
                  <div className="h-7 w-full bg-secondary/20 rounded-lg" />
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 px-2 text-center space-y-3">
                <span className="text-xs text-muted-foreground/70">Pi 核心服务未连接</span>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={onSettings}
                  className="h-7 text-xs border-border/80 text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  检查设置
                </Button>
              </div>
            )
          ) : (
            <div className="space-y-4 py-2 w-full min-w-0">
              {error && (
                <div role="alert" className="px-2 text-xs text-destructive">
                  {error}
                </div>
              )}
              <PinnedSection
                entries={model.pinned}
                collapsed={preferences.collapsed.pinned}
                onToggle={() => {
                  void save({ collapsed: { pinned: !preferences.collapsed.pinned } })
                }}
                projectProps={projectProps}
                expandedProjects={expandedProjects}
                expandedProjectItemLimits={expandedProjectItemLimits}
                toggleProject={toggleProject}
                toggleProjectItems={toggleProjectItems}
                sortable={sortable}
                onReorder={(keys) => onReorderSessions('pinned', keys)}
                onReorderSessions={onReorderSessions}
              />
              {preferences.groupMode === 'projects' && (
                <ProjectsSection
                  entries={model.projects}
                  collapsed={preferences.collapsed.projects}
                  onToggle={() => {
                    void save({ collapsed: { projects: !preferences.collapsed.projects } })
                  }}
                  showAllProjects={showAllProjects}
                  onToggleAllProjects={() => setShowAllProjects((value) => !value)}
                  ready={ready}
                  onDirectory={onDirectory}
                  menu={preferencesMenu}
                  projectProps={projectProps}
                  expandedProjects={expandedProjects}
                  expandedProjectItemLimits={expandedProjectItemLimits}
                  toggleProject={toggleProject}
                  toggleProjectItems={toggleProjectItems}
                  sortable={sortable}
                  onReorder={(keys) => onReorderSessions('projects', keys)}
                  onReorderSessions={onReorderSessions}
                />
              )}
              <RecentsSection
                entries={model.recents}
                collapsed={preferences.collapsed.recents}
                onToggle={() => {
                  void save({ collapsed: { recents: !preferences.collapsed.recents } })
                }}
                recentsLimit={recentsLimit}
                onChangeLimit={setRecentsLimit}
                activeSessionId={activeSessionId}
                activeSessionPath={effectiveActivePath}
                onSwitchSession={onSwitchSession}
                onTogglePin={onTogglePin}
                onPrefetchSession={onPrefetchSession}
                sessionsLoading={sessionsLoading}
                sortable={sortable}
                onReorder={(keys) => onReorderSessions('recents', keys)}
                actions={
                  preferences.groupMode === 'merged' && (
                    <>
                      {preferencesMenu}
                      <button
                        type="button"
                        aria-label="新聊天"
                        title="新聊天"
                        onClick={onNewSession}
                        className="rounded p-1 transition-colors duration-200 ease-out hover:bg-secondary"
                      >
                        <SquarePen className="size-3.5" />
                      </button>
                    </>
                  )
                }
              />
            </div>
          )}
        </div>
      </aside>
      <SessionSearchDialog
        searchHistory={searchHistory}
        open={searchOpen}
        onOpenChange={setSearchOpen}
        entries={model.sessions}
        onSelect={(entry) => onSwitchSession(entry.session.path)}
      />
    </SidebarMenus>
  )
}
