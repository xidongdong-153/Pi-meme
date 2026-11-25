import { useState, type CSSProperties, type ReactNode } from 'react'
import { Folder, Menu, SquarePen } from 'lucide-react'
import type { AppearanceMode } from '@pi-meme/contracts/settings'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { cn } from '@pi-meme/ui/lib/utils'
import type { UserProfile } from '../settings/user-profile'
import { MobileSessionDrawer, type MobileDrawerModel } from './mobile-session-drawer'
import { useSyncThemeColor, useVisualViewportHeight } from './use-mobile-web'

export function MobileChatShell({
  hasConversation,
  isStandalone,
  projectName,
  title,
  connectionStatus,
  connected,
  disconnectedBanner,
  onRetryConnection,
  drawerModel,
  activeServiceId,
  activeSessionId,
  activeSessionPath,
  activeProjectCwd,
  disconnectedServiceIds,
  profile,
  profileLoading,
  appearanceMode,
  onChangeAppearanceMode,
  onNewSession,
  onSwitchSession,
  onSearch,
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
  drawerModel: MobileDrawerModel
  activeServiceId: string
  activeSessionId?: string
  activeSessionPath?: string
  activeProjectCwd?: string
  disconnectedServiceIds?: ReadonlySet<string>
  profile: UserProfile
  profileLoading: boolean
  appearanceMode: AppearanceMode
  onChangeAppearanceMode?: (mode: AppearanceMode) => void
  onNewSession: () => void
  onSwitchSession: (serviceId: string, sessionPath: string) => void
  onSearch?: () => void
  children: ReactNode
}) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const viewportHeight = useVisualViewportHeight(true)
  useSyncThemeColor(true, appearanceMode)

  const hasUnreadAttention = drawerModel.sessions.some(
    (entry) =>
      !disconnectedServiceIds?.has(entry.serviceId) && Boolean(entry.session.inputUnread ?? entry.session.needsInput),
  )

  const shellStyle: CSSProperties | undefined = viewportHeight ? { height: `${viewportHeight}px` } : undefined

  return (
    <div
      data-mobile-web=""
      style={shellStyle}
      className="mobile-web-shell relative flex h-dvh w-dvw flex-col overflow-hidden bg-background text-foreground"
    >
      {/* 极简移动顶栏（48px + 安全区） */}
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/40 bg-background/95 px-2 pb-1 pt-[max(0.25rem,env(safe-area-inset-top))] backdrop-blur-xs">
        <button
          type="button"
          aria-label="打开会话列表"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
          className="relative inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-foreground/85 transition-colors active:bg-secondary"
        >
          <Menu className="size-5" />
          {hasUnreadAttention && (
            <span
              aria-label="有等待回复的会话"
              className="absolute right-2 top-2 size-2 rounded-full bg-primary ring-2 ring-background"
            />
          )}
        </button>

        {/* 中央标题区 */}
        <div className="flex min-w-0 flex-1 items-center justify-center">
          {hasConversation ? (
            <Popover open={infoOpen} onOpenChange={setInfoOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={`查看当前会话信息：${title}`}
                  className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-foreground transition-colors active:bg-secondary/70"
                >
                  {!isStandalone && <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
                  <span className="truncate">{title}</span>
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="bottom"
                align="center"
                sideOffset={8}
                className="w-72 max-w-[calc(100vw-32px)] space-y-2 rounded-2xl p-3.5 text-sm shadow-xl"
              >
                <p className="font-medium leading-snug text-foreground [overflow-wrap:anywhere]">{title}</p>
                <div className="space-y-1 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <Folder aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="truncate">{isStandalone ? '不在项目中工作' : projectName}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className={cn('size-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-amber-500')}
                    />
                    <span>{connectionStatus}</span>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <span className="truncate text-sm font-semibold tracking-tight text-foreground">Pi meme</span>
          )}
        </div>

        {/* 右侧：对话态提供一键新聊天，新聊天态留空保持视觉平衡 */}
        {hasConversation ? (
          <button
            type="button"
            aria-label="新聊天"
            onClick={onNewSession}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-foreground/85 transition-colors active:bg-secondary"
          >
            <SquarePen className="size-[18px]" />
          </button>
        ) : (
          <span aria-hidden="true" className="size-10 shrink-0" />
        )}
      </header>

      {/* 断线 / 同步异常提示条 */}
      {disconnectedBanner && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 bg-secondary/70 px-4 py-1.5 text-xs text-muted-foreground"
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

      {/* 主会话画布 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>

      {/* 单列左侧会话抽屉 */}
      <MobileSessionDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        model={drawerModel}
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
        onNewSession={onNewSession}
        onSwitchSession={onSwitchSession}
        onSearch={onSearch}
      />
    </div>
  )
}
