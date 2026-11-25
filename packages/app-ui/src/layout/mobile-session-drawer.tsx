import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, Loader2, Monitor, Moon, Search, SquarePen, Sun, X } from 'lucide-react'
import type { AppearanceMode } from '@pi-meme/contracts/settings'
import type { PiSessionSummary } from '@pi-meme/contracts/sessions'
import { BrandMark } from '@pi-meme/ui/components/brand-mark'
import { cn } from '@pi-meme/ui/lib/utils'
import type {
  buildSidebarModel,
  SidebarEntry,
  SidebarProjectEntry,
  SidebarSessionEntry,
} from '@pi-meme/workspace/ui/sidebar/sidebar-model'
import { formatSessionTitle } from '@pi-meme/workspace/ui/sidebar/session-title'
import type { UserProfile } from '../settings/user-profile'

export type MobileDrawerModel = ReturnType<typeof buildSidebarModel>

const MODE_LABELS: Record<AppearanceMode, string> = {
  system: '跟随系统',
  light: '浅色主题',
  dark: '深色主题',
}

function nextAppearanceMode(mode: AppearanceMode): AppearanceMode {
  if (mode === 'system') return 'light'
  if (mode === 'light') return 'dark'
  return 'system'
}

export function MobileSessionDrawer({
  open,
  onClose,
  model,
  activeServiceId,
  activeSessionId,
  activeSessionPath,
  activeProjectCwd,
  disconnectedServiceIds,
  connectionStatus,
  connected,
  profile,
  profileLoading,
  appearanceMode,
  onChangeAppearanceMode,
  onNewSession,
  onSwitchSession,
  onSearch,
}: {
  open: boolean
  onClose: () => void
  model: MobileDrawerModel
  activeServiceId: string
  activeSessionId?: string
  activeSessionPath?: string
  activeProjectCwd?: string
  disconnectedServiceIds?: ReadonlySet<string>
  connectionStatus: string
  connected: boolean
  profile: UserProfile
  profileLoading: boolean
  appearanceMode: AppearanceMode
  onChangeAppearanceMode?: (mode: AppearanceMode) => void
  onNewSession: () => void
  onSwitchSession: (serviceId: string, sessionPath: string) => void
  onSearch?: () => void
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set())
  const [expandedLimits, setExpandedLimits] = useState<Set<string>>(() => new Set())
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [recentsLimit, setRecentsLimit] = useState(12)

  // 自动展开当前会话所属项目
  const activeProjectKey = useMemo(() => {
    if (!activeProjectCwd) return undefined
    const matched = [...model.pinned, ...model.projects].find(
      (entry): entry is SidebarProjectEntry =>
        entry.kind === 'project' && entry.serviceId === activeServiceId && entry.project.cwd === activeProjectCwd,
    )
    return matched?.key
  }, [model.pinned, model.projects, activeServiceId, activeProjectCwd])

  useEffect(() => {
    if (!activeProjectKey) return
    setExpandedProjects((previous) =>
      previous.has(activeProjectKey) ? previous : new Set(previous).add(activeProjectKey),
    )
  }, [activeProjectKey])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    closeButtonRef.current?.focus({ preventScroll: true })
  }, [open])

  const isSessionActive = (serviceId: string, session: PiSessionSummary) =>
    serviceId === activeServiceId &&
    (activeSessionPath ? activeSessionPath === session.path : activeSessionId === session.id)

  const toggleProject = (key: string) => {
    setExpandedProjects((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleProjectLimit = (key: string) => {
    setExpandedLimits((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const renderSessionRow = (serviceId: string, session: PiSessionSummary, indented = false) => {
    const offline = Boolean(disconnectedServiceIds?.has(serviceId))
    const active = isSessionActive(serviceId, session)
    const needsInput = Boolean((session.inputUnread ?? session.needsInput) && !offline)
    const running = Boolean(session.running && !session.isPaused && !session.needsInput && !offline)
    const title = formatSessionTitle(session)

    return (
      <button
        key={`${serviceId}:${session.path}`}
        type="button"
        disabled={offline}
        aria-current={active ? 'page' : undefined}
        onClick={() => {
          onClose()
          onSwitchSession(serviceId, session.path)
        }}
        className={cn(
          'flex min-h-[42px] w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors active:bg-secondary/80 disabled:opacity-45',
          indented && 'pl-8',
          active ? 'bg-secondary font-medium text-foreground' : 'text-foreground/85 hover:bg-secondary/50',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {needsInput ? (
          <span aria-label="等待回复" className="size-2 shrink-0 rounded-full bg-primary" />
        ) : running ? (
          <Loader2 aria-label="运行中" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
      </button>
    )
  }

  const renderProjectGroup = (entry: SidebarProjectEntry) => {
    const { key, serviceId, project } = entry
    const expanded = expandedProjects.has(key)
    const expandedAll = expandedLimits.has(key)
    const sessions = expandedAll ? project.sessions : project.sessions.slice(0, 6)
    const offline = Boolean(disconnectedServiceIds?.has(serviceId))
    const hasPending = !offline && project.sessions.some((item) => item.inputUnread ?? item.needsInput)

    return (
      <div key={key} className="space-y-0.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => toggleProject(key)}
          className="flex min-h-[42px] w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-foreground/90 transition-colors hover:bg-secondary/50 active:bg-secondary/80"
        >
          {expanded ? (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          )}
          <Folder className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
          {hasPending && !expanded && (
            <span aria-label="包含待处理会话" className="size-2 shrink-0 rounded-full bg-primary" />
          )}
          {project.sessions.length > 0 && (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{project.sessions.length}</span>
          )}
        </button>
        {expanded && (
          <div className="space-y-0.5">
            {sessions.length > 0 ? (
              <>
                {sessions.map((session) => renderSessionRow(serviceId, session, true))}
                {project.sessions.length > 6 && (
                  <button
                    type="button"
                    onClick={() => toggleProjectLimit(key)}
                    className="flex min-h-[36px] w-full items-center pl-8 pr-3 text-xs text-muted-foreground active:text-foreground"
                  >
                    {expandedAll ? '收起' : `展开其余 ${project.sessions.length - 6} 条`}
                  </button>
                )}
              </>
            ) : (
              <p className="py-1.5 pl-8 pr-3 text-xs text-muted-foreground">暂无会话</p>
            )}
          </div>
        )}
      </div>
    )
  }

  const renderEntry = (entry: SidebarEntry) =>
    entry.kind === 'project'
      ? renderProjectGroup(entry)
      : renderSessionRow(entry.serviceId, (entry as SidebarSessionEntry).session)

  const visibleProjects = showAllProjects
    ? model.projects
    : model.projects.filter(
        (entry, index) =>
          index < 6 ||
          entry.key === activeProjectKey ||
          entry.project.sessions.some((session) => session.running || session.inputUnread || session.needsInput),
      )

  const visibleRecents = model.recents.filter(
    (entry, index) =>
      index < recentsLimit ||
      entry.session.running ||
      entry.session.inputUnread ||
      entry.session.needsInput ||
      isSessionActive(entry.serviceId, entry.session),
  )

  const nextMode = nextAppearanceMode(appearanceMode)

  return (
    <div
      aria-hidden={!open}
      inert={!open}
      className={cn(
        'fixed inset-0 z-50 flex transition-opacity duration-200 motion-reduce:transition-none',
        open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      {/* 遮罩层 */}
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" />

      {/* 单列滑出抽屉 */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="会话列表"
        className={cn(
          'relative z-10 flex h-full w-[min(84vw,320px)] max-w-full flex-col border-r border-border/70 bg-background text-foreground shadow-2xl transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* 抽屉顶栏 */}
        <div className="flex shrink-0 items-center justify-between border-b border-border/40 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <div className="flex items-center gap-2 pl-1">
            <BrandMark size={20} />
            <span className="text-sm font-semibold tracking-tight">Pi meme</span>
          </div>
          <div className="flex items-center gap-0.5">
            {onSearch && (
              <button
                type="button"
                aria-label="搜索会话"
                onClick={() => {
                  onClose()
                  onSearch()
                }}
                className="inline-flex size-10 items-center justify-center rounded-xl text-muted-foreground transition-colors active:bg-secondary active:text-foreground"
              >
                <Search className="size-[18px]" />
              </button>
            )}
            <button
              ref={closeButtonRef}
              type="button"
              aria-label="关闭侧边栏"
              onClick={onClose}
              className="inline-flex size-10 items-center justify-center rounded-xl text-muted-foreground transition-colors active:bg-secondary active:text-foreground"
            >
              <X className="size-[18px]" />
            </button>
          </div>
        </div>

        {/* 新聊天入口 */}
        <div className="shrink-0 px-3 pt-3 pb-1.5">
          <button
            type="button"
            onClick={() => {
              onClose()
              onNewSession()
            }}
            className="flex min-h-[44px] w-full items-center gap-2.5 rounded-xl bg-secondary/60 px-3.5 text-sm font-medium text-foreground transition-colors active:bg-secondary"
          >
            <SquarePen className="size-[18px] shrink-0 text-foreground/80" />
            <span>新聊天</span>
          </button>
        </div>

        {/* 会话滚动区（纯浏览与点击切换） */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-y-contain px-2 py-2">
          {model.pinned.length > 0 && (
            <section aria-label="置顶" className="space-y-1">
              <h2 className="px-3 text-xs font-medium text-muted-foreground">置顶</h2>
              <div className="space-y-0.5">{model.pinned.map(renderEntry)}</div>
            </section>
          )}

          {model.projects.length > 0 && (
            <section aria-label="项目" className="space-y-1">
              <h2 className="px-3 text-xs font-medium text-muted-foreground">项目</h2>
              <div className="space-y-0.5">
                {visibleProjects.map(renderProjectGroup)}
                {model.projects.length > 6 && (
                  <button
                    type="button"
                    onClick={() => setShowAllProjects((value) => !value)}
                    className="flex min-h-[38px] w-full items-center px-3 text-xs text-muted-foreground active:text-foreground"
                  >
                    {showAllProjects ? '收起项目' : `展开全部 ${model.projects.length} 个项目`}
                  </button>
                )}
              </div>
            </section>
          )}

          <section aria-label="最近" className="space-y-1">
            <h2 className="px-3 text-xs font-medium text-muted-foreground">最近</h2>
            {visibleRecents.length > 0 ? (
              <div className="space-y-0.5">
                {visibleRecents.map((entry) => renderSessionRow(entry.serviceId, entry.session))}
                {model.recents.length > recentsLimit && (
                  <button
                    type="button"
                    onClick={() => setRecentsLimit((limit) => limit + 12)}
                    className="flex min-h-[38px] w-full items-center px-3 text-xs text-muted-foreground active:text-foreground"
                  >
                    查看更多
                  </button>
                )}
              </div>
            ) : (
              <p className="px-3 py-2 text-xs text-muted-foreground">暂无最近会话</p>
            )}
          </section>
        </div>

        {/* 底部状态条：用户信息 + 连接状态 + 主题切换 */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/50 px-3 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#e8a838] text-xs font-bold text-neutral-900">
              {profileLoading ? (
                <span className="size-full animate-pulse rounded-full bg-muted" />
              ) : profile.avatarUrl ? (
                <img src={profile.avatarUrl} alt={profile.name} className="size-full rounded-full object-cover" />
              ) : (
                profile.avatarText
              )}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground">
                {profileLoading ? '加载中…' : profile.name}
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  aria-hidden="true"
                  className={cn('size-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-amber-500')}
                />
                <span className="truncate">{connectionStatus}</span>
              </div>
            </div>
          </div>

          {onChangeAppearanceMode && (
            <button
              type="button"
              aria-label={`当前${MODE_LABELS[appearanceMode]}，点击切换到${MODE_LABELS[nextMode]}`}
              onClick={() => onChangeAppearanceMode(nextMode)}
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors active:bg-secondary active:text-foreground"
            >
              {appearanceMode === 'light' ? (
                <Sun className="size-[18px]" />
              ) : appearanceMode === 'dark' ? (
                <Moon className="size-[18px]" />
              ) : (
                <Monitor className="size-[18px]" />
              )}
            </button>
          )}
        </div>
      </aside>
    </div>
  )
}
