import { BookOpen, Folder, Gauge, Gift, Home, Keyboard, LifeBuoy, Settings } from 'lucide-react'
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

export function AppRail({
  profile,
  profileLoading,
  onSettings,
  onUsage,
  onAccount,
  onHome,
  homeActive = false,
  onProjects,
  projectsActive = false,
  className,
}: {
  profile: UserProfile
  profileLoading: boolean
  onSettings?: () => void
  onUsage?: () => void
  onAccount?: () => void
  onHome?: () => void
  homeActive?: boolean
  onProjects?: () => void
  projectsActive?: boolean
  className?: string
}) {
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)

  return (
    <nav
      aria-label="应用导航轨"
      className={cn(
        'group/app-rail relative z-40 flex h-full w-[50px] shrink-0 flex-col items-center justify-between pb-3 select-none bg-transparent',
        className,
      )}
    >
      {/* 顶部应用入口 */}
      <div className="flex w-full flex-col items-center gap-1.5 pt-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="首页"
              aria-current={homeActive ? 'page' : undefined}
              onClick={onHome}
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
      </div>

      {/* 底部个人账户头像与菜单 */}
      <div className="flex flex-col items-center">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="用户菜单与设置"
                  aria-busy={profileLoading}
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

          <DropdownMenuContent side="right" align="end" sideOffset={12} className="w-52 p-1.5">
            {/* 1. 顶部展示头像 - 名称（无 Pro 订阅标识，点击直达个人资料） */}
            <div
              role="button"
              tabIndex={0}
              onClick={onAccount}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onAccount?.()
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
              <span className="text-[10px] text-muted-foreground/80 font-mono tracking-tighter">
                {isMac ? '⌘,' : 'Ctrl+,'}
              </span>
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
                <DropdownMenuItem disabled className="gap-2.5 py-1.5">
                  <Keyboard className="size-4 text-muted-foreground" />
                  <span>快捷键设置</span>
                </DropdownMenuItem>
                <DropdownMenuItem disabled className="gap-2.5 py-1.5">
                  <BookOpen className="size-4 text-muted-foreground" />
                  <span>用户指南</span>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  )
}
