import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Folder, Layers, PanelLeft, Pencil, Pin, PinOff, SquarePen } from 'lucide-react'
import type { AppearanceMode } from '@pi-meme/contracts/settings'
import type { UsageStatsSnapshot } from '@pi-meme/contracts/usage'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { cn } from '@pi-meme/ui/lib/utils'
import { getSettingsSection, type SettingsSection } from '../settings/settings-page'
import type { UserProfile } from '../settings/user-profile'
import { MobileSessionDrawer, type MobileDrawerModel, type MobilePrimaryNav } from './mobile-session-drawer'
import {
  useMobileBackNavigation,
  useMobileDrawerSwipe,
  useMobileForegroundSync,
  useSyncThemeColor,
  useVisualViewportHeight,
} from './use-mobile-web'

export function MobileChatShell({
  hasConversation,
  isStandalone,
  projectName,
  title,
  connectionStatus,
  connected,
  disconnectedBanner,
  onRetryConnection,
  onForegroundResume,
  drawerModel,
  sessionsLoading = false,
  activeServiceId,
  activeSessionId,
  activeSessionPath,
  activeProjectCwd,
  disconnectedServiceIds,
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
  workSheetOpen = false,
  onCloseWorkSheet,
  workSheetBadge = 0,
  onOpenWorkSheet,
  activeNav = 'chat',
  schedulesUnread = false,
  onNavigatePrimary,
  subpageTitle,
  subpageContent,
  customDrawerPanel,
  settingsOpen = false,
  settingsSection = 'general',
  settingsSaving = false,
  showBrowserSettings = false,
  onOpenSettings,
  onCloseSettings,
  settingsContent,
  serviceSwitchSlot,
  children,
}: {
  hasConversation: boolean
  isStandalone: boolean
  projectName: string
  title: string
  connectionStatus: string
  connected: boolean
  disconnectedBanner?: string
  onRetryConnection?: () => void
  onForegroundResume?: () => void
  drawerModel: MobileDrawerModel
  sessionsLoading?: boolean
  activeServiceId: string
  activeSessionId?: string
  activeSessionPath?: string
  activeProjectCwd?: string
  disconnectedServiceIds?: ReadonlySet<string>
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
  workSheetOpen?: boolean
  onCloseWorkSheet?: () => void
  workSheetBadge?: number
  onOpenWorkSheet?: () => void
  activeNav?: MobilePrimaryNav
  schedulesUnread?: boolean
  onNavigatePrimary?: (nav: MobilePrimaryNav) => void
  subpageTitle?: string
  subpageContent?: ReactNode
  customDrawerPanel?: { title: string; content: ReactNode }
  settingsOpen?: boolean
  settingsSection?: SettingsSection
  settingsSaving?: boolean
  showBrowserSettings?: boolean
  onOpenSettings?: (section: SettingsSection) => void
  onCloseSettings?: () => void
  settingsContent?: ReactNode
  serviceSwitchSlot?: ReactNode
  children: ReactNode
}) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [renamingCurrent, setRenamingCurrent] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState('')
  const viewportHeight = useVisualViewportHeight(true)
  useSyncThemeColor(true, appearanceMode)
  useMobileForegroundSync(true, onForegroundResume)
  useMobileDrawerSwipe({
    enabled: !workSheetOpen && !renamingCurrent,
    open: drawerOpen,
    onOpen: () => setDrawerOpen(true),
    onClose: () => setDrawerOpen(false),
  })

  const backLayers = useMemo(
    () => [
      { active: Boolean(workSheetOpen), onBack: () => onCloseWorkSheet?.() },
      { active: drawerOpen, onBack: () => setDrawerOpen(false) },
      { active: settingsOpen, onBack: () => onCloseSettings?.() },
      { active: !settingsOpen && activeNav !== 'chat', onBack: () => onNavigatePrimary?.('chat') },
    ],
    [workSheetOpen, onCloseWorkSheet, drawerOpen, settingsOpen, onCloseSettings, activeNav, onNavigatePrimary],
  )
  useMobileBackNavigation(true, backLayers)

  const hasUnreadAttention = drawerModel.sessions.some(
    (entry) =>
      !disconnectedServiceIds?.has(entry.serviceId) && Boolean(entry.session.inputUnread ?? entry.session.needsInput),
  )
  const isCurrentPinned = Boolean(
    activeSessionPath &&
    (pinnedKeys.includes(`${activeServiceId}:${activeSessionPath}`) || pinnedKeys.includes(activeSessionPath)),
  )
  const currentSettingsMeta = settingsOpen ? getSettingsSection(settingsSection) : null
  const isSubpage = !settingsOpen && activeNav !== 'chat'

  const shellStyle: CSSProperties | undefined = viewportHeight ? { height: `${viewportHeight}px` } : undefined

  const submitCurrentRename = async () => {
    if (!activeSessionPath || !onRenameSession || renameBusy) return
    const next = renameValue.replace(/[\r\n]+/g, ' ').trim()
    if (!next) {
      setRenameError('名称不能为空')
      return
    }
    setRenameBusy(true)
    setRenameError('')
    try {
      await onRenameSession(activeServiceId, activeSessionPath, next)
      setRenamingCurrent(false)
    } catch (cause) {
      setRenameError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRenameBusy(false)
    }
  }

  return (
    <div
      data-mobile-web=""
      style={shellStyle}
      className="mobile-web-shell relative flex h-dvh w-dvw flex-col overflow-hidden bg-background text-foreground"
    >
      {/* 52px 无硬边移动顶栏（滚动穿过时显露细底线） */}
      <header
        className={cn(
          'flex min-h-[52px] shrink-0 items-center justify-between gap-1.5 bg-background/92 px-2 pb-1 pt-[max(0.25rem,env(safe-area-inset-top))] backdrop-blur-xs transition-[border-color] duration-150',
          scrolled ? 'border-b border-[var(--surface-hairline)]' : 'border-b border-transparent',
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            aria-label={settingsOpen ? '打开设置目录' : isSubpage ? '打开页面导航' : '打开侧边栏'}
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
            className="relative inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-foreground/85 transition-colors active:bg-secondary"
          >
            <PanelLeft className="size-5" />
            {!settingsOpen && (hasUnreadAttention || schedulesUnread) && (
              <span
                aria-label="有未读提醒"
                className="absolute right-2 top-2 size-2 rounded-full bg-primary ring-2 ring-background"
              />
            )}
          </button>

          {/* 设置页或 P2 一级子页：顶栏标题左对齐紧邻 PanelLeft */}
          {settingsOpen && currentSettingsMeta ? (
            <h1 className="truncate text-base font-semibold tracking-tight text-foreground">
              {currentSettingsMeta.label}
            </h1>
          ) : isSubpage && subpageTitle ? (
            <h1 className="truncate text-base font-semibold tracking-tight text-foreground">{subpageTitle}</h1>
          ) : null}
        </div>

        {/* 聊天态中央区域 */}
        {!settingsOpen && !isSubpage && (
          <div className="flex min-w-0 flex-1 items-center justify-center">
            {hasConversation ? (
              <Popover open={infoOpen} onOpenChange={setInfoOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={`会话信息与操作：${title}`}
                    className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[15px] font-medium text-foreground transition-colors active:bg-secondary/70"
                  >
                    {!isStandalone && <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className="truncate">{title}</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="center"
                  sideOffset={8}
                  className="w-72 max-w-[calc(100vw-32px)] space-y-2.5 rounded-2xl border-border/80 bg-popover p-3 text-sm shadow-xl"
                >
                  <div className="space-y-1 px-1">
                    <p className="font-medium leading-snug text-foreground [overflow-wrap:anywhere]">{title}</p>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Folder aria-hidden="true" className="size-3.5 shrink-0" />
                      <span className="truncate">{isStandalone ? '不在项目中工作' : projectName}</span>
                    </div>
                  </div>
                  {(onRenameSession || onTogglePin || onOpenWorkSheet) && (
                    <div className="space-y-0.5 border-t border-border/50 pt-1.5">
                      {activeSessionPath && onRenameSession && (
                        <button
                          type="button"
                          onClick={() => {
                            setInfoOpen(false)
                            setRenameValue(title)
                            setRenameError('')
                            setRenamingCurrent(true)
                          }}
                          className="flex min-h-[40px] w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-sm text-foreground/90 transition-colors active:bg-secondary"
                        >
                          <Pencil className="size-4 text-muted-foreground" />
                          <span>重命名会话</span>
                        </button>
                      )}
                      {activeSessionPath && onTogglePin && (
                        <button
                          type="button"
                          onClick={() => {
                            setInfoOpen(false)
                            onTogglePin(activeServiceId, activeSessionPath)
                          }}
                          className="flex min-h-[40px] w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-sm text-foreground/90 transition-colors active:bg-secondary"
                        >
                          {isCurrentPinned ? (
                            <PinOff className="size-4 text-muted-foreground" />
                          ) : (
                            <Pin className="size-4 text-muted-foreground" />
                          )}
                          <span>{isCurrentPinned ? '取消置顶' : '置顶会话'}</span>
                        </button>
                      )}
                      {onOpenWorkSheet && (
                        <button
                          type="button"
                          onClick={() => {
                            setInfoOpen(false)
                            onOpenWorkSheet()
                          }}
                          className="flex min-h-[40px] w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-sm text-foreground/90 transition-colors active:bg-secondary"
                        >
                          <Layers className="size-4 text-muted-foreground" />
                          <span>查看工作区产出</span>
                        </button>
                      )}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            ) : (
              (serviceSwitchSlot ?? null)
            )}
          </div>
        )}

        {/* 右侧操作区 */}
        {settingsOpen ? (
          <button
            type="button"
            disabled={settingsSaving}
            onClick={onCloseSettings}
            className="inline-flex h-10 shrink-0 items-center justify-center rounded-xl px-3 text-sm font-medium text-muted-foreground transition-colors active:bg-secondary active:text-foreground disabled:opacity-45"
          >
            完成
          </button>
        ) : isSubpage ? (
          <button
            type="button"
            onClick={() => onNavigatePrimary?.('chat')}
            className="inline-flex h-10 shrink-0 items-center justify-center rounded-xl px-3 text-sm font-medium text-muted-foreground transition-colors active:bg-secondary active:text-foreground"
          >
            返回聊天
          </button>
        ) : hasConversation ? (
          <div className="flex shrink-0 items-center gap-0.5">
            {onOpenWorkSheet && (
              <button
                type="button"
                aria-label={workSheetBadge > 0 ? `查看工作区产出（${workSheetBadge} 项）` : '查看工作区产出'}
                onClick={onOpenWorkSheet}
                className="relative inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-foreground/85 transition-colors active:bg-secondary"
              >
                <Layers className="size-[18px]" />
                {workSheetBadge > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute right-1.5 top-1.5 flex min-w-[14px] items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-[14px] text-primary-foreground"
                  >
                    {workSheetBadge > 9 ? '9+' : workSheetBadge}
                  </span>
                )}
              </button>
            )}
            <button
              type="button"
              aria-label="新聊天"
              onClick={onNewSession}
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-foreground/85 transition-colors active:bg-secondary"
            >
              <SquarePen className="size-[18px]" />
            </button>
          </div>
        ) : (
          <span aria-hidden="true" className="size-10 shrink-0" />
        )}
      </header>

      {/* 断线 / 同步异常提示条（仅异常时出现） */}
      {disconnectedBanner && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 bg-secondary/75 px-4 py-1.5 text-xs text-muted-foreground"
        >
          <span className="min-w-0 truncate">{disconnectedBanner}</span>
          {onRetryConnection && (
            <button
              type="button"
              onClick={onRetryConnection}
              className="shrink-0 font-medium text-primary active:opacity-70"
            >
              重试
            </button>
          )}
        </div>
      )}

      {/* 主画布：全页设置 / P2 一级子页 / 主会话工作区 */}
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        onScrollCapture={(event) => {
          const target = event.target
          if (target instanceof HTMLElement) {
            setScrolled(target.scrollTop > 8)
          }
        }}
      >
        {settingsOpen ? settingsContent : isSubpage ? subpageContent : children}
      </div>

      {/* 双栏复合侧边抽屉 */}
      <MobileSessionDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        model={drawerModel}
        sessionsLoading={sessionsLoading}
        activeServiceId={activeServiceId}
        activeSessionId={activeSessionId}
        activeSessionPath={activeSessionPath}
        activeProjectCwd={activeProjectCwd}
        disconnectedServiceIds={disconnectedServiceIds}
        connectionStatus={connectionStatus}
        connected={connected}
        profile={profile}
        profileLoading={profileLoading}
        appearanceMode={appearanceMode}
        onChangeAppearanceMode={onChangeAppearanceMode}
        pinnedKeys={pinnedKeys}
        multiServiceActions={multiServiceActions}
        onNewSession={onNewSession}
        onNewSessionInProject={onNewSessionInProject}
        onSwitchSession={onSwitchSession}
        onSearch={onSearch}
        onTogglePin={onTogglePin}
        onRenameSession={onRenameSession}
        onDeleteSession={onDeleteSession}
        onRenameProject={onRenameProject}
        loadUsageStats={loadUsageStats}
        activeNav={activeNav}
        schedulesUnread={schedulesUnread}
        onNavigatePrimary={onNavigatePrimary}
        customDrawerPanel={customDrawerPanel}
        settingsOpen={settingsOpen}
        settingsSection={settingsSection}
        settingsSaving={settingsSaving}
        showBrowserSettings={showBrowserSettings}
        onOpenSettings={onOpenSettings}
        onGoHome={onCloseSettings}
      />

      {/* 当前会话重命名弹窗 */}
      <Dialog
        open={renamingCurrent}
        onOpenChange={(next) => {
          if (!next && !renameBusy) setRenamingCurrent(false)
        }}
      >
        <DialogContent className="w-[min(calc(100vw-32px),360px)] rounded-2xl p-5">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submitCurrentRename()
            }}
            className="space-y-4"
          >
            <DialogHeader>
              <DialogTitle>重命名会话</DialogTitle>
            </DialogHeader>
            <Input
              aria-label="会话名称"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              disabled={renameBusy}
              className="h-10 text-base"
            />
            {renameError && (
              <p role="alert" className="text-xs text-destructive">
                {renameError}
              </p>
            )}
            <DialogFooter className="flex-row justify-end gap-2">
              <Button type="button" variant="outline" disabled={renameBusy} onClick={() => setRenamingCurrent(false)}>
                取消
              </Button>
              <Button type="submit" disabled={renameBusy || !renameValue.trim()}>
                {renameBusy ? '保存中…' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
