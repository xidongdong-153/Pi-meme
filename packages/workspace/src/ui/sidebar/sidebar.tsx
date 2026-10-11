import { SidebarMenus, type SidebarMenuBridge } from './sidebar-menus'
import type { WorkspaceDeletionResult } from '@pi-meme/contracts/desktop'
import { useState } from 'react'
import { Settings, SquarePen } from 'lucide-react'
import type { PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import { Button } from '@pi-meme/ui/components/ui/button'
import { BrandMark } from '@pi-meme/ui/components/brand-mark'
import { ScrollArea } from '@pi-meme/ui/components/ui/scroll-area'
import { SessionItem } from './session-item'
import { PinnedSection } from './pinned-section'
import { ProjectsSection } from './projects-section'
import { RecentsSection } from './recents-section'

export type SidebarProps = {
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
  menuBridge,
  onMenuChanged,
  onMenuDeleted,
  projectName,
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
  const [standaloneExpanded, setStandaloneExpanded] = useState(true)
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
  const projects = sessionsSnapshot?.projects ?? []
  const recents = sessionsSnapshot?.recents ?? []

  // 置顶项：项目或会话
  const pinnedProjects = projects.filter((project) => pinnedSet.has(project.cwd))
  const pinnedSessions = recents.filter((session) => pinnedSet.has(session.path))
  const openNewSession = (targetCwd: string) => {
    setExpandedProjects((prev) => new Set(prev).add(targetCwd))
    onNewSessionInProject(targetCwd)
  }

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
        className="appearance-sidebar flex h-full w-full flex-col border-r border-border bg-card/60 backdrop-blur-md select-none shrink-0"
        aria-label="侧边栏"
      >
        {/* 侧边栏顶部品牌 */}
        <div className="flex h-10 items-center px-3 border-b border-border/40 shrink-0">
          <div className="flex items-center gap-2 font-semibold text-xs text-foreground/90">
            <BrandMark size={20} />
            <span>pi-meme</span>
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
        <ScrollArea className="flex-1 px-3">
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
              <PinnedSection
                expandedProjects={expandedProjects}
                pinnedProjects={pinnedProjects}
                pinnedSessions={pinnedSessions}
                activeSessionId={activeSessionId}
                activeSessionPath={effectiveActivePath}
                toggleProject={toggleProject}
                onNewSessionInProject={openNewSession}
                onTogglePin={onTogglePin}
                onSwitchSession={onSwitchSession}
                onPrefetchSession={onPrefetchSession}
              />
              <ProjectsSection
                showAllProjects={showAllProjects}
                onToggleAllProjects={() => setShowAllProjects((value) => !value)}
                projects={projects}
                sessionsLoading={sessionsLoading}
                ready={ready}
                onDirectory={onDirectory}
                cwd={cwd}
                projectName={projectName}
                expandedProjects={expandedProjects}
                expandedProjectItemLimits={expandedProjectItemLimits}
                pinnedSet={pinnedSet}
                activeSessionId={activeSessionId}
                activeSessionPath={effectiveActivePath}
                toggleProject={toggleProject}
                toggleProjectItems={toggleProjectItems}
                onNewSessionInProject={openNewSession}
                onSwitchSession={onSwitchSession}
                onTogglePin={onTogglePin}
                onPrefetchSession={onPrefetchSession}
              />
              {Boolean(sessionsSnapshot?.standaloneSessions?.length) && (
                <div>
                  <button
                    type="button"
                    aria-expanded={standaloneExpanded}
                    onClick={() => setStandaloneExpanded((value) => !value)}
                    className="flex w-full items-center justify-between px-2 py-1 text-[0.6875rem] font-semibold text-muted-foreground transition-colors duration-200 ease-out hover:text-foreground"
                  >
                    <span>未归属项目</span>
                    <span>{standaloneExpanded ? '收起' : '展开'}</span>
                  </button>
                  <div
                    aria-hidden={!standaloneExpanded}
                    inert={!standaloneExpanded}
                    className={`grid transition-[grid-template-rows,opacity] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] ${standaloneExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
                  >
                    <div className="min-h-0 overflow-hidden">
                      {sessionsSnapshot?.standaloneSessions?.map((session) => (
                        <SessionItem
                          key={session.path}
                          session={session}
                          variant="recent"
                          isActive={session.path === effectiveActivePath || session.id === activeSessionId}
                          isPinned={pinnedSet.has(session.path)}
                          onSwitchSession={onSwitchSession}
                          onTogglePin={onTogglePin}
                          onPrefetchSession={onPrefetchSession}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
              <RecentsSection
                recentsLimit={recentsLimit}
                onChangeLimit={setRecentsLimit}
                recents={recents}
                pinnedSet={pinnedSet}
                activeSessionId={activeSessionId}
                activeSessionPath={effectiveActivePath}
                onSwitchSession={onSwitchSession}
                onTogglePin={onTogglePin}
                onPrefetchSession={onPrefetchSession}
                sessionsLoading={sessionsLoading}
              />
            </div>
          )}
        </ScrollArea>

        {/* 底部设置入口 */}
        <div className="flex items-center justify-between border-t border-border px-3 py-2.5 text-xs text-muted-foreground bg-card/40">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onSettings}
            aria-label="设置"
            className="text-muted-foreground hover:text-foreground size-7 shrink-0"
          >
            <Settings className="size-4" />
          </Button>
        </div>
      </aside>
    </SidebarMenus>
  )
}
