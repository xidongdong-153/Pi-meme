import { Home } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'

export function AppRail({
  onSettings,
  onToggleSidebar,
  sidebarOpen = true,
  className,
}: {
  onSettings?: () => void
  onToggleSidebar?: () => void
  sidebarOpen?: boolean
  className?: string
}) {
  return (
    <nav
      aria-label="应用导航轨"
      className={cn(
        'group/app-rail relative z-40 flex h-full w-[50px] shrink-0 flex-col items-center justify-between pb-3 select-none bg-transparent',
        className,
      )}
    >
      {/* 顶部仅保留首页 (主聊天页面) */}
      <div className="flex w-full flex-col items-center gap-1.5 pt-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={sidebarOpen ? '收起会话抽屉' : '展开会话抽屉'}
              onClick={onToggleSidebar}
              className="flex size-8 items-center justify-center rounded-lg bg-background/80 text-foreground shadow-xs transition-colors hover:bg-background cursor-pointer"
            >
              <Home className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            {sidebarOpen ? '会话抽屉（点击折叠）' : '展开会话抽屉'}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* 底部个人账户头像 */}
      <div className="flex flex-col items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="打开设置与个人资料"
              onClick={onSettings}
              className="flex size-7 items-center justify-center rounded-full bg-[#e8a838] text-[0.625rem] font-bold text-neutral-900 shadow-xs transition-transform hover:scale-105 active:scale-95 cursor-pointer"
            >
              XD
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            设置与账户
          </TooltipContent>
        </Tooltip>
      </div>
    </nav>
  )
}
