import { useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, Copy, Ellipsis, FolderOpen, GitFork, PanelLeft, Pencil, Pin, PinOff } from 'lucide-react'
import type { ProjectApp } from '@pi-meme/contracts/desktop'
import type { PiSessionSummary } from '@pi-meme/contracts/sessions'
import { useSidebarMenus } from '@pi-meme/workspace/ui/sidebar/sidebar-menus'
import { Button } from '@pi-meme/ui/components/ui/button'
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
import { PageHeaderNavigation } from './page-header'
import { useShortcuts } from '../shortcuts/shortcut-provider'

function SidebarTools({
  nativeWindow,
  sidebarOpen,
  onToggleSidebar,
}: {
  nativeWindow: boolean
  sidebarOpen: boolean
  onToggleSidebar: () => void
}) {
  const shortcuts = useShortcuts()
  const sidebarShortcut = shortcuts.getShortcutLabel('toggleSidebar')

  return (
    <>
      <PageHeaderNavigation nativeWindow={nativeWindow} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggleSidebar}
            aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
            aria-expanded={sidebarOpen}
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <PanelLeft className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
          {sidebarShortcut ? ` · ${sidebarShortcut}` : ''}
        </TooltipContent>
      </Tooltip>
    </>
  )
}

export function AppHeader({
  nativeWindow,
  canOpenProject,
  loadProjectApps,
  sidebarOpen,
  onToggleSidebar,
  busy,
  cwd,
  onDirectory,
  directoryDisabledReason,
  project,
  title,
  sessionName,
  session,
  canRenameSession,
  onOpenProject,
  preferredApp,
  onPreferredApp,
  forkedFrom,
  onOpenForkSource,
  workspaceTabs,
}: {
  workspaceTabs?: (menu: ReactNode) => ReactNode
  nativeWindow: boolean
  canOpenProject: boolean
  loadProjectApps: () => Promise<ProjectApp[]>
  sidebarOpen: boolean
  onToggleSidebar: () => void
  busy: boolean
  cwd: string
  onDirectory: (trigger?: HTMLButtonElement) => void
  directoryDisabledReason?: string
  project: string
  title: string
  sessionName?: string
  session?: PiSessionSummary
  canRenameSession: boolean
  onOpenProject: (app: ProjectApp['id']) => void
  preferredApp: ProjectApp['id']
  onPreferredApp: (app: ProjectApp['id']) => void
  /** 当前会话的分叉来源，用于显示来源标识并支持返回。 */
  forkedFrom?: { path: string; title: string }
  onOpenForkSource?: (sourcePath: string) => void
}) {
  const menus = useSidebarMenus()
  const trigger = useRef<HTMLButtonElement>(null)
  const isPinned = Boolean(session && menus.pinnedPaths.includes(session.path))
  const [menuOpen, setMenuOpen] = useState(false)
  const [apps, setApps] = useState<ProjectApp[]>([])
  const [appsLoading, setAppsLoading] = useState(false)
  const [appsError, setAppsError] = useState('')
  const appsLock = useRef(false)
  const [copied, setCopied] = useState(false)
  const effectivePreferredApp = apps.some((app) => app.id === preferredApp) ? preferredApp : 'finder'

  async function loadApps(open: boolean) {
    setMenuOpen(open)
    if (open) menus.dialogTrigger.current = trigger.current
    if (!open || !canOpenProject || appsLock.current) return
    appsLock.current = true
    setAppsLoading(true)
    setAppsError('')
    try {
      setApps(await loadProjectApps())
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      const prefix = '无法识别本机应用：'
      setAppsError(message.includes(prefix) ? message.slice(message.indexOf(prefix)) : `${prefix}${message}`)
      setApps((previous) =>
        previous.some((app) => app.id === 'finder')
          ? previous
          : [{ id: 'finder', name: '系统文件管理器' }, ...previous],
      )
    } finally {
      appsLock.current = false
      setAppsLoading(false)
    }
  }

  function chooseApp(app: ProjectApp['id']) {
    setMenuOpen(false)
    onPreferredApp(app)
    onOpenProject(app)
  }

  async function copyPath() {
    await navigator.clipboard.writeText(cwd)
    setCopied(true)
    setTimeout(setCopied, 1200, false)
  }

  const sessionMenu = (
    <DropdownMenu open={menuOpen} onOpenChange={(open) => void loadApps(open)}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          ref={trigger}
          aria-label="会话菜单"
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground data-[state=open]:bg-background/60 data-[state=open]:text-foreground"
        >
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="w-52"
        onCloseAutoFocus={(event) => {
          if (menus.dialogOpening.current) {
            menus.dialogOpening.current = false
            event.preventDefault()
          }
        }}
      >
        {workspaceTabs && (
          <DropdownMenuItem
            disabled={busy}
            onSelect={() => {
              // 项目弹窗接管焦点，菜单关闭时不再聚焦回省略号按钮。
              menus.dialogOpening.current = true
              onDirectory(trigger.current ?? undefined)
            }}
          >
            <FolderOpen />
            选择项目：{project}
          </DropdownMenuItem>
        )}
        {workspaceTabs && forkedFrom && (
          <DropdownMenuItem onSelect={() => onOpenForkSource?.(forkedFrom.path)}>
            <GitFork />
            返回来源会话
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={!session || !canRenameSession}
          onSelect={() => session && menus.rename({ kind: 'session', session })}
        >
          <Pencil />
          重命名
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!session || busy} onSelect={() => session && menus.onTogglePin(session.path)}>
          {isPinned ? <PinOff /> : <Pin />}
          {isPinned ? '取消置顶' : '置顶'}
        </DropdownMenuItem>
        {canOpenProject && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <ArrowUpRight />
                在…打开
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-52">
                {appsLoading && !apps.length && <DropdownMenuItem disabled>正在识别应用…</DropdownMenuItem>}
                {appsError && (
                  <div role="alert" className="px-2.5 py-2 text-xs text-destructive break-words">
                    {appsError}
                  </div>
                )}
                {apps.map((app) => (
                  <DropdownMenuItem key={app.id} onSelect={() => chooseApp(app.id)}>
                    <span className="flex-1">{app.name}</span>
                    {effectivePreferredApp === app.id && <span className="text-primary">默认</span>}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault()
                    void copyPath()
                  }}
                >
                  <Copy />
                  {copied ? '已复制路径' : '复制项目路径'}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <div className="flex h-full min-w-0 w-full items-center justify-between window-drag select-none bg-transparent">
      {/* 分区 1：左顶栏（宽度 = 50px AppRail + var(--workspace-sidebar-width)，与下方左侧栏精确对齐） */}
      <div
        className="flex h-full min-w-max shrink-0 items-center justify-between pr-3 bg-transparent relative"
        style={{ width: 'calc(50px + var(--workspace-sidebar-width))' }}
      >
        <SidebarTools nativeWindow={nativeWindow} sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} />
        {/* 与下方目录栏右边缘严格对齐的短竖向分割线，折叠时隐藏 */}
        {sidebarOpen && <div className="absolute right-0 top-1/2 -translate-y-1/2 h-4 w-px bg-white/15 shrink-0" />}
      </div>

      {/* 分区 2：中间顶栏（flex-1，与下方主会话画布精确对齐） */}
      <div className="flex h-full items-center justify-between min-w-0 flex-1 px-4 bg-transparent">
        {workspaceTabs ? (
          workspaceTabs(sessionMenu)
        ) : (
          <>
            <div className="flex items-center gap-1.5 min-w-0">
              <button
                type="button"
                disabled={busy}
                title={directoryDisabledReason || cwd}
                aria-label="在顶栏选择项目"
                onClick={(event) => onDirectory(event.currentTarget)}
                className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-background/50 hover:text-foreground transition-colors max-w-[160px] truncate disabled:opacity-50 cursor-pointer"
              >
                <FolderOpen className="size-3.5 text-muted-foreground shrink-0" />
                <span className="truncate">{project}</span>
              </button>
              <span className="text-muted-foreground/30 text-xs select-none">/</span>
              <span
                className="text-xs font-medium text-foreground/90 truncate max-w-[420px]"
                title={sessionName || title}
              >
                {title}
              </span>
              {forkedFrom && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-testid="fork-source"
                      onClick={() => onOpenForkSource?.(forkedFrom.path)}
                      aria-label={`返回来源会话：${forkedFrom.title}`}
                      className="flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[0.6875rem] text-primary transition-colors hover:bg-primary/20 max-w-[180px]"
                    >
                      <GitFork className="size-3 shrink-0" />
                      <span className="truncate">返回</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{`返回来源会话：${forkedFrom.title}`}</TooltipContent>
                </Tooltip>
              )}
            </div>

            {sessionMenu}
          </>
        )}
      </div>
    </div>
  )
}
