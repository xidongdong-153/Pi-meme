import { useRef, useState } from 'react'
import {
  Circle,
  Clock,
  BookOpen,
  Folder,
  Gauge,
  Gift,
  Home,
  Images,
  Keyboard,
  LifeBuoy,
  Plug,
  Puzzle,
  Settings,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'
import type { UserProfile } from '../settings/user-profile'
import type { RegisteredNavigation } from '@pi-meme/plugin-sdk/navigation'
import { useShortcuts } from '../shortcuts/shortcut-provider'

/** 折叠态首页的悬停会话浮层。只在聊天工作区传入，其他页面没有这套入口。 */
export type HomeFlyoutControl = {
  open: boolean
  onPointerEnter: () => void
  onPointerLeave: () => void
  onKeyboardOpen: () => void
}

export function AppRail({
  profile,
  profileLoading,
  onSettings,
  onUsage,
  onAccount,
  onHome,
  homeActive = false,
  homeFlyout,
  onImages,
  imagesActive = false,
  onProjects,
  projectsActive = false,
  onSchedules,
  schedulesActive = false,
  schedulesUnread = false,
  onPlugins,
  pluginsActive = false,
  pluginNavigation = [],
  activePluginId,
  onPlugin,
  onShortcutHelp,
  className,
}: {
  profile: UserProfile
  profileLoading: boolean
  onSettings?: () => void
  onUsage?: () => void
  onAccount?: () => void
  onHome?: () => void
  homeActive?: boolean
  homeFlyout?: HomeFlyoutControl
  onImages?: () => void
  imagesActive?: boolean
  onProjects?: () => void
  projectsActive?: boolean
  onSchedules?: () => void
  schedulesActive?: boolean
  schedulesUnread?: boolean
  onPlugins?: () => void
  pluginsActive?: boolean
  pluginNavigation?: readonly RegisteredNavigation[]
  activePluginId?: string
  onPlugin?: (entry: RegisteredNavigation) => void
  onShortcutHelp?: () => void
  className?: string
}) {
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const restoringUserMenuFocus = useRef(false)
  const openAccount = () => {
    setUserMenuOpen(false)
    onAccount?.()
  }
  const shortcuts = useShortcuts()
  const settingsShortcut = shortcuts.getShortcutLabel('openSettings')

  return (
    <nav
      aria-label="应用导航轨"
      className={cn(
        'group/app-rail relative z-40 flex h-full w-[50px] shrink-0 flex-col items-center justify-between pb-3 select-none bg-transparent',
        className,
      )}
    >
      {/* 顶部应用入口 */}
      <div className="flex min-h-0 w-full flex-col items-center gap-1.5 pt-2">
        {/* 会话工作区里首页改用悬停浮层，不再叠一个提示气泡。 */}
        <Tooltip open={homeFlyout ? false : undefined}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="首页"
              aria-current={homeActive ? 'page' : undefined}
              aria-expanded={homeFlyout?.open}
              aria-controls={homeFlyout?.open ? 'workspace-sidebar-flyout' : undefined}
              data-home-trigger={homeFlyout ? '' : undefined}
              onClick={onHome}
              onPointerEnter={homeFlyout?.onPointerEnter}
              onPointerLeave={homeFlyout?.onPointerLeave}
              onKeyDown={
                homeFlyout
                  ? (event) => {
                      if (event.key !== 'ArrowRight' || event.defaultPrevented) return
                      event.preventDefault()
                      homeFlyout.onKeyboardOpen()
                    }
                  : undefined
              }
              className={cn(
                'flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-background cursor-pointer',
                homeActive
                  ? 'bg-background/80 text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Home className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            {homeActive ? '新聊天' : '返回聊天'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="项目"
              aria-current={projectsActive ? 'page' : undefined}
              onClick={onProjects}
              className={cn(
                'flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-background cursor-pointer',
                projectsActive
                  ? 'bg-background/80 text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Folder className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            项目
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={schedulesUnread ? '定时任务，有未读结果' : '定时任务'}
              aria-current={schedulesActive ? 'page' : undefined}
              onClick={onSchedules}
              className={cn(
                'relative flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-background cursor-pointer',
                schedulesActive
                  ? 'bg-background/80 text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Clock className="size-4" />
              {schedulesUnread && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-blue-500" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            定时任务
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="插件"
              aria-current={pluginsActive ? 'page' : undefined}
              onClick={onPlugins}
              className={cn(
                'flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-background cursor-pointer',
                pluginsActive
                  ? 'bg-background/80 text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="relative size-4" aria-hidden="true">
                <Circle className="size-4" />
                <Plug className="absolute inset-[3px] size-2.5 -rotate-45" />
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            插件与技能
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="图像"
              aria-current={imagesActive ? 'page' : undefined}
              onClick={onImages}
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-background cursor-pointer',
                imagesActive
                  ? 'bg-background/80 text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Images className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            图像
          </TooltipContent>
        </Tooltip>
        {pluginNavigation.length > 0 && (
          <>
            <div className="my-1 h-px w-6 shrink-0 bg-border" />
            <div
              className="flex min-h-0 w-full flex-col items-center gap-1.5 overflow-y-auto"
              aria-label="插件业务入口"
            >
              {pluginNavigation.map((entry) => (
                <Tooltip key={entry.pluginId}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`打开插件页面：${entry.title}`}
                      aria-current={activePluginId === entry.pluginId ? 'page' : undefined}
                      onClick={() => onPlugin?.(entry)}
                      className={cn(
                        'flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg text-muted-foreground transition-colors hover:bg-background hover:text-foreground [&>svg]:size-4',
                        activePluginId === entry.pluginId && 'bg-background/80 text-foreground shadow-xs',
                      )}
                    >
                      {entry.icon ?? <Puzzle className="size-4" />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {entry.title}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 底部个人账户头像与菜单 */}
      <div className="flex flex-col items-center">
        <DropdownMenu open={userMenuOpen} onOpenChange={setUserMenuOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="用户菜单与设置"
                  aria-busy={profileLoading}
                  onFocus={(event) => {
                    if (restoringUserMenuFocus.current) event.preventDefault()
                  }}
                  className="flex size-7 items-center justify-center rounded-full bg-[#e8a838] text-[0.625rem] font-bold text-neutral-900 shadow-xs transition-transform hover:scale-105 active:scale-95 cursor-pointer outline-none overflow-hidden"
                >
                  {profileLoading ? (
                    <span className="size-full animate-pulse rounded-full bg-muted" />
                  ) : profile.avatarUrl ? (
                    <img src={profile.avatarUrl} alt={profile.name} className="size-full rounded-full object-cover" />
                  ) : (
                    profile.avatarText
                  )}
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              设置与账户
            </TooltipContent>
          </Tooltip>

          {/* 关闭时立即卸载 Portal，避免跳转后继续围绕已隐藏的头像定位。 */}
          {userMenuOpen && (
            <DropdownMenuContent
              side="right"
              align="end"
              sideOffset={12}
              className="w-52 p-1.5"
              onCloseAutoFocus={() => {
                // Radix 随后同步恢复头像焦点；这次聚焦不应再次打开 Tooltip。
                restoringUserMenuFocus.current = true
                queueMicrotask(() => {
                  restoringUserMenuFocus.current = false
                })
              }}
            >
              {/* 1. 顶部展示头像 - 名称（无 Pro 订阅标识，点击直达个人资料） */}
              <div
                role="button"
                tabIndex={0}
                onClick={openAccount}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openAccount()
                  }
                }}
                className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg select-none hover:bg-secondary/60 transition-colors cursor-pointer group"
              >
                <div className="flex size-7 items-center justify-center rounded-full bg-[#e8a838] text-[0.625rem] font-bold text-neutral-900 shrink-0 shadow-xs overflow-hidden">
                  {profileLoading ? (
                    <span className="size-full animate-pulse rounded-full bg-muted" />
                  ) : profile.avatarUrl ? (
                    <img src={profile.avatarUrl} alt={profile.name} className="size-full rounded-full object-cover" />
                  ) : (
                    profile.avatarText
                  )}
                </div>
                <span className="text-xs font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                  {profileLoading ? '正在加载个人资料…' : profile.name}
                </span>
              </div>

              <DropdownMenuSeparator />

              {/* 2. 用量 */}
              <DropdownMenuItem onClick={onUsage} className="gap-2.5 py-2">
                <Gauge className="size-4 text-muted-foreground" />
                <span>用量</span>
              </DropdownMenuItem>

              {/* 3. 设置 */}
              <DropdownMenuItem onClick={onSettings} className="gap-2.5 py-2 justify-between">
                <div className="flex items-center gap-2.5">
                  <Settings className="size-4 text-muted-foreground" />
                  <span>设置</span>
                </div>
                {settingsShortcut && (
                  <span className="text-[10px] text-muted-foreground/80 font-mono tracking-tighter">
                    {settingsShortcut}
                  </span>
                )}
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              {/* 4. 帮助二级菜单 */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2.5 py-2">
                  <LifeBuoy className="size-4 text-muted-foreground" />
                  <span>帮助</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent sideOffset={14} alignOffset={-4} className="w-40 p-1">
                  <DropdownMenuItem disabled className="gap-2.5 py-1.5">
                    <Gift className="size-4 text-muted-foreground" />
                    <span>新功能</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!onShortcutHelp}
                    onClick={onShortcutHelp}
                    className="gap-2.5 py-1.5 cursor-pointer"
                  >
                    <Keyboard className="size-4 text-muted-foreground" />
                    <span>键盘快捷键</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled className="gap-2.5 py-1.5">
                    <BookOpen className="size-4 text-muted-foreground" />
                    <span>用户指南</span>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          )}
        </DropdownMenu>
      </div>
    </nav>
  )
}
