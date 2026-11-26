import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Ellipsis,
  Folder,
  Gauge,
  Home,
  Info,
  LibraryBig,
  Loader2,
  Monitor,
  Moon,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Search,
  Settings,
  SquarePen,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import type { AppearanceMode } from '@pi-meme/contracts/settings'
import type { PiProjectGroup, PiSessionSummary } from '@pi-meme/contracts/sessions'
import type { UsageStatsSnapshot } from '@pi-meme/contracts/usage'
import { BrandMark } from '@pi-meme/ui/components/brand-mark'
import { Button } from '@pi-meme/ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@pi-meme/ui/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { cn } from '@pi-meme/ui/lib/utils'
import type {
  buildSidebarModel,
  SidebarEntry,
  SidebarProjectEntry,
  SidebarSessionEntry,
} from '@pi-meme/workspace/ui/sidebar/sidebar-model'
import { formatSessionTitle } from '@pi-meme/workspace/ui/sidebar/session-title'
import { SettingsDirectory, type SettingsSection } from '../settings/settings-page'
import type { UserProfile } from '../settings/user-profile'

export type MobileDrawerModel = ReturnType<typeof buildSidebarModel>
export type MobilePrimaryNav = 'chat' | 'materials' | 'projects' | 'schedules' | 'customization'

const APPEARANCE_MODES: readonly { mode: AppearanceMode; label: string; icon: typeof Monitor }[] = [
  { mode: 'system', label: '系统', icon: Monitor },
  { mode: 'light', label: '浅色', icon: Sun },
  { mode: 'dark', label: '深色', icon: Moon },
]

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return String(tokens)
}

function summarizeUsage(snapshot: UsageStatsSnapshot) {
  const todayTokens = snapshot.daily.find((item) => item.date === snapshot.today)?.tokens ?? 0
  const recent7 = snapshot.daily.slice(-7).reduce((sum, item) => sum + item.tokens, 0)
  return { todayTokens, recent7, totalTokens: snapshot.totalTokens }
}

type DrawerDialogState =
  | { kind: 'rename-session'; serviceId: string; session: PiSessionSummary }
  | { kind: 'rename-project'; serviceId: string; project: PiProjectGroup }
  | { kind: 'delete-session'; serviceId: string; session: PiSessionSummary }
  | { kind: 'session-details'; session: PiSessionSummary; projectName?: string }

export function MobileSessionDrawer({
  open,
  onClose,
  model,
  sessionsLoading = false,
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
  pinnedKeys = [],
  multiServiceActions = false,
  onNewSession,
  onNewSessionInProject,
  onSwitchSession,
  onSearch,
  onTogglePin,
  onRenameSession,
  onDeleteSession,
  onRenameProject,
  loadUsageStats,
  activeNav = 'chat',
  schedulesUnread = false,
  onNavigatePrimary,
  customDrawerPanel,
  settingsOpen = false,
  settingsSection = 'general',
  settingsSaving = false,
  showBrowserSettings = false,
  onOpenSettings,
  onGoHome,
}: {
  open: boolean
  onClose: () => void
  model: MobileDrawerModel
  sessionsLoading?: boolean
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
  pinnedKeys?: readonly string[]
  multiServiceActions?: boolean
  onNewSession: () => void
  onNewSessionInProject?: (serviceId: string, cwd: string) => void
  onSwitchSession: (serviceId: string, sessionPath: string) => void
  onSearch?: () => void
  onTogglePin?: (serviceId: string, path: string) => void
  onRenameSession?: (serviceId: string, sessionPath: string, name: string) => Promise<void>
  onDeleteSession?: (serviceId: string, sessionPath: string) => Promise<void>
  onRenameProject?: (serviceId: string, cwd: string, name: string) => Promise<void>
  loadUsageStats?: () => Promise<UsageStatsSnapshot>
  activeNav?: MobilePrimaryNav
  schedulesUnread?: boolean
  onNavigatePrimary?: (nav: MobilePrimaryNav) => void
  customDrawerPanel?: { title: string; content: ReactNode }
  settingsOpen?: boolean
  settingsSection?: SettingsSection
  settingsSaving?: boolean
  showBrowserSettings?: boolean
  onOpenSettings?: (section: SettingsSection) => void
  onGoHome?: () => void
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set())
  const [expandedLimits, setExpandedLimits] = useState<Set<string>>(() => new Set())
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [recentsLimit, setRecentsLimit] = useState(12)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [usageSnapshot, setUsageSnapshot] = useState<UsageStatsSnapshot | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageError, setUsageError] = useState('')
  const [dialog, setDialog] = useState<DrawerDialogState | null>(null)
  const [dialogInput, setDialogInput] = useState('')
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState('')

  const pinnedSet = useMemo(() => new Set(pinnedKeys), [pinnedKeys])
  const isPinned = (serviceId: string, targetPath: string) =>
    pinnedSet.has(`${serviceId}:${targetPath}`) || (serviceId === activeServiceId && pinnedSet.has(targetPath))

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
    if (!open) {
      setProfileMenuOpen(false)
      setUsageOpen(false)
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !dialog) {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose, dialog])

  useEffect(() => {
    if (!open) return
    closeButtonRef.current?.focus({ preventScroll: true })
  }, [open])

  const openUsagePopover = (next: boolean) => {
    setUsageOpen(next)
    if (!next || !loadUsageStats) return
    setUsageLoading(true)
    setUsageError('')
    void loadUsageStats()
      .then((snapshot) => setUsageSnapshot(snapshot))
      .catch((cause) => setUsageError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setUsageLoading(false))
  }

  const navigateSettings = (section: SettingsSection) => {
    setProfileMenuOpen(false)
    setUsageOpen(false)
    onClose()
    onOpenSettings?.(section)
  }

  const openRenameSession = (serviceId: string, session: PiSessionSummary) => {
    setDialogInput(formatSessionTitle(session))
    setDialogError('')
    setDialog({ kind: 'rename-session', serviceId, session })
  }

  const openRenameProject = (serviceId: string, project: PiProjectGroup) => {
    setDialogInput(project.name)
    setDialogError('')
    setDialog({ kind: 'rename-project', serviceId, project })
  }

  const openDeleteSession = (serviceId: string, session: PiSessionSummary) => {
    setDialogError('')
    setDialog({ kind: 'delete-session', serviceId, session })
  }

  const submitDialog = async () => {
    if (!dialog || dialogBusy || dialog.kind === 'session-details') return
    setDialogBusy(true)
    setDialogError('')
    try {
      if (dialog.kind === 'rename-session') {
        const next = dialogInput.replace(/[\r\n]+/g, ' ').trim()
        if (!next) throw new Error('名称不能为空')
        await onRenameSession?.(dialog.serviceId, dialog.session.path, next)
      } else if (dialog.kind === 'rename-project') {
        const next = dialogInput.replace(/[\r\n]+/g, ' ').trim()
        if (!next) throw new Error('项目名称不能为空')
        await onRenameProject?.(dialog.serviceId, dialog.project.cwd, next)
      } else if (dialog.kind === 'delete-session') {
        await onDeleteSession?.(dialog.serviceId, dialog.session.path)
      }
      setDialog(null)
    } catch (cause) {
      setDialogError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDialogBusy(false)
    }
  }

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

  const renderSessionRow = (serviceId: string, session: PiSessionSummary, indented = false, projectName?: string) => {
    const offline = Boolean(disconnectedServiceIds?.has(serviceId))
    const active = isSessionActive(serviceId, session)
    const needsInput = Boolean((session.inputUnread ?? session.needsInput) && !offline)
    const running = Boolean(session.running && !session.isPaused && !session.needsInput && !offline)
    const title = formatSessionTitle(session)
    const canOperate = (multiServiceActions || serviceId === activeServiceId) && !offline
    const pinned = isPinned(serviceId, session.path)
    const showMenu = canOperate && Boolean(onTogglePin || onRenameSession || onDeleteSession)

    return (
      <div
        key={`${serviceId}:${session.path}`}
        className={cn(
          'flex min-h-[44px] w-full items-center rounded-xl transition-colors',
          indented && 'pl-5',
          active ? 'bg-secondary font-medium text-foreground' : 'text-foreground/85 hover:bg-secondary/50',
          offline && 'opacity-45',
        )}
      >
        <button
          type="button"
          disabled={offline}
          aria-current={active ? 'page' : undefined}
          onClick={() => {
            onClose()
            onSwitchSession(serviceId, session.path)
          }}
          className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 py-2 pl-3 pr-1.5 text-left text-[14px] active:opacity-75 disabled:cursor-not-allowed"
        >
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {needsInput ? (
            <span aria-label="等待回复" className="size-2 shrink-0 rounded-full bg-primary" />
          ) : running ? (
            <Loader2 aria-label="运行中" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : null}
        </button>

        {showMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`会话操作：${title}`}
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground/70 transition-colors active:bg-secondary active:text-foreground"
              >
                <Ellipsis className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end" sideOffset={4} className="w-44 rounded-xl p-1">
              {onTogglePin && (
                <DropdownMenuItem
                  onSelect={() => onTogglePin(serviceId, session.path)}
                  className="min-h-[40px] gap-2.5 rounded-lg text-sm"
                >
                  {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                  <span>{pinned ? '取消置顶' : '置顶会话'}</span>
                </DropdownMenuItem>
              )}
              {onRenameSession && (
                <DropdownMenuItem
                  onSelect={() => openRenameSession(serviceId, session)}
                  className="min-h-[40px] gap-2.5 rounded-lg text-sm"
                >
                  <Pencil className="size-4" />
                  <span>重命名</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() => setDialog({ kind: 'session-details', session, projectName })}
                className="min-h-[40px] gap-2.5 rounded-lg text-sm"
              >
                <Info className="size-4" />
                <span>会话详情</span>
              </DropdownMenuItem>
              {onDeleteSession && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => openDeleteSession(serviceId, session)}
                    className="min-h-[40px] gap-2.5 rounded-lg text-sm text-destructive focus:text-destructive"
                  >
                    <Trash2 className="size-4" />
                    <span>删除会话</span>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    )
  }

  const renderProjectGroup = (entry: SidebarProjectEntry) => {
    const { key, serviceId, project } = entry
    const expanded = expandedProjects.has(key)
    const expandedAll = expandedLimits.has(key)
    const sessions = expandedAll ? project.sessions : project.sessions.slice(0, 6)
    const offline = Boolean(disconnectedServiceIds?.has(serviceId))
    const hasPending = !offline && project.sessions.some((item) => item.inputUnread ?? item.needsInput)
    const canOperate = (multiServiceActions || serviceId === activeServiceId) && !offline
    const pinned = isPinned(serviceId, project.cwd)

    return (
      <div key={key} className="space-y-0.5">
        <div
          className={cn(
            'flex min-h-[44px] w-full items-center rounded-xl text-foreground/90 transition-colors hover:bg-secondary/50',
            offline && 'opacity-50',
          )}
        >
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => toggleProject(key)}
            className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 py-2 pl-2.5 pr-1 text-left text-[14px] active:opacity-75"
          >
            {expanded ? (
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            )}
            <Folder className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
            {offline ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">离线</span>
            ) : hasPending && !expanded ? (
              <span aria-label="包含待处理会话" className="size-2 shrink-0 rounded-full bg-primary" />
            ) : project.sessions.length > 0 ? (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{project.sessions.length}</span>
            ) : null}
          </button>

          {canOperate && (
            <div className="flex shrink-0 items-center">
              {onNewSessionInProject && (
                <button
                  type="button"
                  aria-label={`在 ${project.name} 中新聊天`}
                  onClick={() => {
                    onClose()
                    onNewSessionInProject(serviceId, project.cwd)
                  }}
                  className="inline-flex size-9 items-center justify-center rounded-xl text-muted-foreground/75 transition-colors active:bg-secondary active:text-foreground"
                >
                  <SquarePen className="size-4" />
                </button>
              )}
              {(onTogglePin || onRenameProject) && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`${project.name} 的操作`}
                      className="inline-flex size-9 items-center justify-center rounded-xl text-muted-foreground/70 transition-colors active:bg-secondary active:text-foreground"
                    >
                      <Ellipsis className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="bottom" align="end" sideOffset={4} className="w-44 rounded-xl p-1">
                    {onTogglePin && (
                      <DropdownMenuItem
                        onSelect={() => onTogglePin(serviceId, project.cwd)}
                        className="min-h-[40px] gap-2.5 rounded-lg text-sm"
                      >
                        {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                        <span>{pinned ? '取消置顶项目' : '置顶项目'}</span>
                      </DropdownMenuItem>
                    )}
                    {onRenameProject && (
                      <DropdownMenuItem
                        onSelect={() => openRenameProject(serviceId, project)}
                        className="min-h-[40px] gap-2.5 rounded-lg text-sm"
                      >
                        <Pencil className="size-4" />
                        <span>重命名项目</span>
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </div>

        {expanded && (
          <div className="space-y-0.5">
            {sessions.length > 0 ? (
              <>
                {sessions.map((session) => renderSessionRow(serviceId, session, true, project.name))}
                {project.sessions.length > 6 && (
                  <button
                    type="button"
                    onClick={() => toggleProjectLimit(key)}
                    className="flex min-h-[38px] w-full items-center pl-8 pr-3 text-xs text-muted-foreground active:text-foreground"
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

  const usageSummary = usageSnapshot ? summarizeUsage(usageSnapshot) : null

  const railNavEntries: readonly {
    id: MobilePrimaryNav
    label: string
    icon: ReactNode
    unread?: boolean
  }[] = [
    { id: 'chat', label: '首页', icon: <Home className="size-[18px]" /> },
    { id: 'materials', label: '资料空间', icon: <LibraryBig className="size-[18px]" /> },
    { id: 'projects', label: '项目', icon: <Folder className="size-[18px]" /> },
    {
      id: 'schedules',
      label: schedulesUnread ? '定时任务，有未读结果' : '定时任务',
      icon: <Clock className="size-[18px]" />,
      unread: schedulesUnread,
    },
    {
      id: 'customization',
      label: '插件与技能',
      icon: (
        <span className="relative size-[18px]" aria-hidden="true">
          <Circle className="size-[18px]" />
          <Plug className="absolute inset-[3.5px] size-[11px] -rotate-45" />
        </span>
      ),
    },
  ]

  return (
    <>
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

        {/* 双栏滑出复合抽屉：52px 应用导航轨 + 上下文次级面板 */}
        <aside
          role="dialog"
          aria-modal="true"
          aria-label={settingsOpen ? '设置导航' : '应用导航与会话列表'}
          className={cn(
            'relative z-10 flex h-full w-[min(85vw,336px)] max-w-full border-r border-border/70 bg-popover text-popover-foreground shadow-2xl transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
            open ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          {/* 左侧 52px 应用导航轨（L1 托底层） */}
          <nav
            aria-label="应用导航"
            className="flex w-[52px] shrink-0 flex-col items-center justify-between border-r border-border/50 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.5rem,env(safe-area-inset-top))] select-none"
            style={{ backgroundColor: 'color-mix(in srgb, var(--background), var(--foreground) 5.5%)' }}
          >
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                aria-label="收起侧边栏"
                onClick={onClose}
                className="inline-flex size-9 items-center justify-center rounded-xl text-foreground/80 transition-colors active:bg-secondary"
              >
                <PanelLeft className="size-[18px]" />
              </button>

              {railNavEntries.map((entry) => {
                const active = !settingsOpen && activeNav === entry.id
                return (
                  <button
                    key={entry.id}
                    type="button"
                    aria-label={entry.label}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      if (entry.id === 'chat') {
                        if (settingsOpen) onGoHome?.()
                        else if (activeNav !== 'chat') onNavigatePrimary?.('chat')
                      } else {
                        onNavigatePrimary?.(entry.id)
                        if (entry.id === 'projects') onClose()
                      }
                    }}
                    className={cn(
                      'relative inline-flex size-9 items-center justify-center rounded-full transition-colors active:scale-95',
                      active
                        ? 'bg-secondary text-foreground shadow-2xs'
                        : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                    )}
                  >
                    {entry.icon}
                    {entry.unread && (
                      <span
                        aria-hidden="true"
                        className="absolute right-1.5 top-1.5 size-2 rounded-full bg-blue-500 ring-2 ring-background"
                      />
                    )}
                  </button>
                )
              })}
            </div>

            {/* 底部固定区：用量浮层 + 个人头像菜单 */}
            <div className="flex flex-col items-center gap-2">
              {onOpenSettings && (
                <Popover open={usageOpen} onOpenChange={openUsagePopover}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label="查看用量"
                      className={cn(
                        'inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground active:bg-secondary',
                        usageOpen && 'bg-secondary text-foreground',
                      )}
                    >
                      <Gauge className="size-[18px]" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="top"
                    align="start"
                    sideOffset={10}
                    className="w-[244px] max-w-[calc(100vw-32px)] space-y-2.5 rounded-2xl border-border/80 bg-popover p-3.5 text-sm shadow-xl"
                  >
                    <div className="text-xs font-medium text-muted-foreground">Token 用量概览</div>
                    {usageLoading && !usageSummary ? (
                      <div className="space-y-2 py-1">
                        <div className="h-4 w-3/4 animate-pulse rounded bg-secondary/70" />
                        <div className="h-4 w-1/2 animate-pulse rounded bg-secondary/70" />
                      </div>
                    ) : usageError ? (
                      <p className="text-xs text-muted-foreground">{usageError}</p>
                    ) : usageSummary ? (
                      <dl className="space-y-1.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <dt className="text-muted-foreground">今日用量</dt>
                          <dd className="font-mono font-medium tabular-nums text-foreground">
                            {formatCompactTokens(usageSummary.todayTokens)}
                          </dd>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <dt className="text-muted-foreground">近 7 日</dt>
                          <dd className="font-mono font-medium tabular-nums text-foreground">
                            {formatCompactTokens(usageSummary.recent7)}
                          </dd>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <dt className="text-muted-foreground">累计总量</dt>
                          <dd className="font-mono font-medium tabular-nums text-foreground">
                            {formatCompactTokens(usageSummary.totalTokens)}
                          </dd>
                        </div>
                      </dl>
                    ) : (
                      <p className="text-xs text-muted-foreground">暂无用量记录</p>
                    )}
                    <div className="border-t border-border/50 pt-2">
                      <button
                        type="button"
                        onClick={() => navigateSettings('profile')}
                        className="flex min-h-[38px] w-full items-center justify-between rounded-xl px-2 text-xs font-medium text-foreground transition-colors active:bg-secondary"
                      >
                        <span>查看详细用量</span>
                        <ChevronRight className="size-3.5 text-muted-foreground" />
                      </button>
                    </div>
                  </PopoverContent>
                </Popover>
              )}

              <Popover open={profileMenuOpen} onOpenChange={setProfileMenuOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="打开个人资料与设置菜单"
                    className="inline-flex size-9 items-center justify-center rounded-full transition-transform active:scale-95"
                  >
                    <span className="flex size-8 items-center justify-center overflow-hidden rounded-full bg-[#e8a838] text-xs font-bold text-neutral-900 shadow-xs">
                      {profileLoading ? (
                        <span className="size-full animate-pulse rounded-full bg-muted" />
                      ) : profile.avatarUrl ? (
                        <img
                          src={profile.avatarUrl}
                          alt={profile.name}
                          className="size-full rounded-full object-cover"
                        />
                      ) : (
                        profile.avatarText
                      )}
                    </span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="start"
                  sideOffset={10}
                  className="w-[252px] max-w-[calc(100vw-32px)] space-y-1.5 rounded-2xl border-border/80 bg-popover p-1.5 text-sm shadow-xl"
                >
                  {/* 顶部名片：唯一连接状态承载点 */}
                  <button
                    type="button"
                    onClick={() => navigateSettings('account')}
                    className="flex min-h-[48px] w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors active:bg-secondary"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#e8a838] text-xs font-bold text-neutral-900">
                      {profileLoading ? (
                        <span className="size-full animate-pulse rounded-full bg-muted" />
                      ) : profile.avatarUrl ? (
                        <img
                          src={profile.avatarUrl}
                          alt={profile.name}
                          className="size-full rounded-full object-cover"
                        />
                      ) : (
                        profile.avatarText
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {profileLoading ? '加载中…' : profile.name}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span
                          aria-hidden="true"
                          className={cn(
                            'size-1.5 shrink-0 rounded-full',
                            connected ? 'bg-emerald-500' : 'bg-amber-500',
                          )}
                        />
                        <span className="truncate">{connectionStatus}</span>
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>

                  {/* 嵌入式外观三态快切条 */}
                  {onChangeAppearanceMode && (
                    <div
                      role="group"
                      aria-label="外观模式快切"
                      className="grid grid-cols-3 gap-1 rounded-xl bg-secondary/55 p-1"
                    >
                      {APPEARANCE_MODES.map(({ mode, label, icon: Icon }) => {
                        const selected = appearanceMode === mode
                        return (
                          <button
                            key={mode}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => onChangeAppearanceMode(mode)}
                            className={cn(
                              'flex h-8 items-center justify-center gap-1 rounded-lg text-xs font-medium transition-colors',
                              selected
                                ? 'bg-background text-foreground shadow-2xs'
                                : 'text-muted-foreground active:text-foreground',
                            )}
                          >
                            <Icon className="size-3.5 shrink-0" />
                            <span>{label}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {onOpenSettings && (
                    <>
                      <div className="my-1 h-px bg-border/60" />
                      <button
                        type="button"
                        onClick={() => navigateSettings('profile')}
                        className="flex min-h-[42px] w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-sm text-foreground/90 transition-colors active:bg-secondary"
                      >
                        <Gauge className="size-4 text-muted-foreground" />
                        <span>用量</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => navigateSettings('general')}
                        className="flex min-h-[42px] w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-sm text-foreground/90 transition-colors active:bg-secondary"
                      >
                        <Settings className="size-4 text-muted-foreground" />
                        <span>设置</span>
                      </button>
                    </>
                  )}
                </PopoverContent>
              </Popover>
            </div>
          </nav>

          {/* 右侧弹性上下文面板 */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {settingsOpen && onOpenSettings ? (
              <>
                <div className="flex shrink-0 items-center justify-between px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
                  <h2 className="pl-1 text-base font-semibold tracking-tight text-foreground">设置</h2>
                  <button
                    ref={closeButtonRef}
                    type="button"
                    aria-label="关闭侧边栏"
                    onClick={onClose}
                    className="inline-flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors active:bg-secondary active:text-foreground"
                  >
                    <X className="size-[18px]" />
                  </button>
                </div>
                <SettingsDirectory
                  mobile
                  showBrowser={showBrowserSettings}
                  sectionId={settingsSection}
                  saving={settingsSaving}
                  onNavigate={(section) => {
                    onClose()
                    onOpenSettings(section)
                  }}
                />
              </>
            ) : customDrawerPanel ? (
              <>
                <div className="flex shrink-0 items-center justify-between px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
                  <h2 className="pl-1 text-base font-semibold tracking-tight text-foreground">
                    {customDrawerPanel.title}
                  </h2>
                  <button
                    ref={closeButtonRef}
                    type="button"
                    aria-label="关闭侧边栏"
                    onClick={onClose}
                    className="inline-flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors active:bg-secondary active:text-foreground"
                  >
                    <X className="size-[18px]" />
                  </button>
                </div>
                <div
                  className="flex min-h-0 flex-1 flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]"
                  onClick={(event) => {
                    const target = event.target instanceof Element ? event.target : null
                    if (target?.closest('button, a') && !target.closest('[data-keep-drawer-open]')) {
                      onClose()
                    }
                  }}
                >
                  {customDrawerPanel.content}
                </div>
              </>
            ) : (
              <>
                {/* 首页抽屉顶栏 */}
                <div className="flex shrink-0 items-center justify-between px-3 pb-1.5 pt-[max(0.5rem,env(safe-area-inset-top))]">
                  <div className="flex items-center gap-2 pl-1">
                    <BrandMark size={18} />
                    <span className="text-[15px] font-semibold tracking-tight">Pi meme</span>
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
                        className="inline-flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors active:bg-secondary active:text-foreground"
                      >
                        <Search className="size-[18px]" />
                      </button>
                    )}
                    <button
                      ref={closeButtonRef}
                      type="button"
                      aria-label="关闭侧边栏"
                      onClick={onClose}
                      className="inline-flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors active:bg-secondary active:text-foreground"
                    >
                      <X className="size-[18px]" />
                    </button>
                  </div>
                </div>

                {/* 轻量透明「新聊天」入口 */}
                <div className="shrink-0 px-2 pt-1 pb-1">
                  <button
                    type="button"
                    onClick={() => {
                      onClose()
                      onNewSession()
                    }}
                    className="flex min-h-[44px] w-full items-center gap-2.5 rounded-xl px-3 text-[15px] font-medium text-foreground transition-colors hover:bg-secondary/50 active:bg-secondary"
                  >
                    <SquarePen className="size-[18px] shrink-0 text-foreground/80" />
                    <span>新聊天</span>
                  </button>
                </div>

                {/* 会话与项目滚动区 */}
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-y-contain px-2 pt-2 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
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
                    {sessionsLoading && visibleRecents.length === 0 ? (
                      <div aria-busy="true" aria-label="正在加载会话列表" className="space-y-2 px-2 py-1">
                        {['w-3/4', 'w-3/5', 'w-4/5', 'w-2/3'].map((width, index) => (
                          <div key={index} className={cn('h-9 animate-pulse rounded-xl bg-secondary/55', width)} />
                        ))}
                      </div>
                    ) : visibleRecents.length > 0 ? (
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
              </>
            )}
          </div>
        </aside>
      </div>

      {/* 移动端会话/项目轻操作弹窗（重命名、删除确认、详情） */}
      <Dialog
        open={dialog !== null}
        onOpenChange={(next) => {
          if (!next && !dialogBusy) setDialog(null)
        }}
      >
        <DialogContent className="w-[min(calc(100vw-32px),360px)] rounded-2xl p-5">
          {dialog?.kind === 'rename-session' || dialog?.kind === 'rename-project' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void submitDialog()
              }}
              className="space-y-4"
            >
              <DialogHeader>
                <DialogTitle>{dialog.kind === 'rename-project' ? '重命名项目' : '重命名会话'}</DialogTitle>
              </DialogHeader>
              <Input
                aria-label={dialog.kind === 'rename-project' ? '项目名称' : '会话名称'}
                value={dialogInput}
                onChange={(event) => setDialogInput(event.target.value)}
                disabled={dialogBusy}
                className="h-10 text-base"
              />
              {dialogError && (
                <p role="alert" className="text-xs text-destructive">
                  {dialogError}
                </p>
              )}
              <DialogFooter className="flex-row justify-end gap-2">
                <Button type="button" variant="outline" disabled={dialogBusy} onClick={() => setDialog(null)}>
                  取消
                </Button>
                <Button type="submit" disabled={dialogBusy || !dialogInput.trim()}>
                  {dialogBusy ? '保存中…' : '保存'}
                </Button>
              </DialogFooter>
            </form>
          ) : dialog?.kind === 'delete-session' ? (
            <div className="space-y-4">
              <DialogHeader>
                <DialogTitle>删除会话？</DialogTitle>
                <DialogDescription>
                  将永久删除会话「{formatSessionTitle(dialog.session)}」，删除后无法恢复。
                </DialogDescription>
              </DialogHeader>
              {dialogError && (
                <p role="alert" className="text-xs text-destructive">
                  {dialogError}
                </p>
              )}
              <DialogFooter className="flex-row justify-end gap-2">
                <Button type="button" variant="outline" disabled={dialogBusy} onClick={() => setDialog(null)}>
                  取消
                </Button>
                <Button type="button" variant="destructive" disabled={dialogBusy} onClick={() => void submitDialog()}>
                  {dialogBusy ? '删除中…' : '确认删除'}
                </Button>
              </DialogFooter>
            </div>
          ) : dialog?.kind === 'session-details' ? (
            <div className="space-y-3">
              <DialogHeader>
                <DialogTitle>会话详情</DialogTitle>
              </DialogHeader>
              <dl className="space-y-2 text-xs">
                <div>
                  <dt className="text-muted-foreground">标题</dt>
                  <dd className="mt-0.5 font-medium text-foreground [overflow-wrap:anywhere]">
                    {formatSessionTitle(dialog.session)}
                  </dd>
                </div>
                {dialog.projectName && (
                  <div>
                    <dt className="text-muted-foreground">所属项目</dt>
                    <dd className="mt-0.5 text-foreground">{dialog.projectName}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-muted-foreground">消息数</dt>
                  <dd className="mt-0.5 tabular-nums text-foreground">{dialog.session.messageCount}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">会话文件</dt>
                  <dd className="mt-0.5 font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                    {dialog.session.path}
                  </dd>
                </div>
              </dl>
              <DialogFooter className="flex-row justify-end">
                <Button type="button" variant="outline" onClick={() => setDialog(null)}>
                  关闭
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
