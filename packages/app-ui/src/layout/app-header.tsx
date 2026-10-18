import { useState } from 'react'
import { ChevronDown, Copy, FolderOpen, GitFork, PanelLeft } from 'lucide-react'
import type { ProjectApp } from '@pi-meme/contracts/desktop'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'
import { PageHeaderNavigation } from './page-header'

const appNames: Record<ProjectApp['id'], string> = {
  finder: 'Finder',
  vscode: 'Visual Studio Code',
  cursor: 'Cursor',
  zed: 'Zed',
}
function SidebarTools({
  nativeWindow,
  sidebarOpen,
  onToggleSidebar,
}: {
  nativeWindow: boolean
  sidebarOpen: boolean
  onToggleSidebar: () => void
}) {
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
        <TooltipContent side="bottom">{sidebarOpen ? '收起侧边栏' : '展开侧边栏'}</TooltipContent>
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
  onOpenProject,
  preferredApp,
  onPreferredApp,
  forkedFrom,
  onOpenForkSource,
}: {
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
  onOpenProject: (app: ProjectApp['id']) => void
  preferredApp: ProjectApp['id']
  onPreferredApp: (app: ProjectApp['id']) => void
  /** 当前会话的分叉来源，用于显示来源标识并支持返回。 */
  forkedFrom?: { path: string; title: string }
  onOpenForkSource?: (sourcePath: string) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [apps, setApps] = useState<ProjectApp[]>([])
  const [copied, setCopied] = useState(false)
  const preferredName = apps.find((app) => app.id === preferredApp)?.name ?? appNames[preferredApp]

  async function loadApps(open: boolean) {
    setMenuOpen(open)
    if (!open) return
    try {
      setApps(await loadProjectApps())
    } catch {
      setApps([])
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

  return (
    <div className="flex h-full min-w-0 w-full items-center justify-between window-drag select-none bg-transparent">
      {/* 分区 1：左顶栏（宽度 = 50px AppRail + var(--workspace-sidebar-width)，与下方左侧栏精确对齐） */}
      <div
        className="flex h-full min-w-max shrink-0 items-center justify-between pr-3 no-drag bg-transparent relative"
        style={{ width: 'calc(50px + var(--workspace-sidebar-width))' }}
      >
        <SidebarTools nativeWindow={nativeWindow} sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} />
        {/* 与下方目录栏右边缘严格对齐的短竖向分割线，折叠时隐藏 */}
        {sidebarOpen && <div className="absolute right-0 top-1/2 -translate-y-1/2 h-4 w-px bg-white/15 shrink-0" />}
      </div>

      {/* 分区 2：中间顶栏（flex-1，与下方主会话画布精确对齐） */}
      <div className="flex h-full items-center justify-between min-w-0 flex-1 px-4 no-drag bg-transparent">
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
          <span className="text-xs font-medium text-foreground/90 truncate max-w-[420px]" title={sessionName || title}>
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

        <div className="flex items-center gap-1 shrink-0">
          <div
            className={cn(
              'flex h-7 items-center rounded-md text-muted-foreground transition-colors',
              menuOpen ? 'bg-background/60 text-foreground' : 'hover:bg-background/40 hover:text-foreground',
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`在 ${preferredName} 中打开项目`}
                  disabled={!canOpenProject}
                  onClick={() => onOpenProject(preferredApp)}
                  className="size-7 rounded-none border-0 text-inherit hover:bg-transparent"
                >
                  <FolderOpen className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {canOpenProject ? `在 ${preferredName} 中打开项目` : '当前连接不支持打开本机项目'}
              </TooltipContent>
            </Tooltip>
            <Popover open={menuOpen} onOpenChange={(open) => void loadApps(open)}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="选择打开项目的应用"
                  disabled={!canOpenProject}
                  className="h-7 w-4.5 rounded-none border-0 px-0 text-inherit hover:bg-transparent"
                >
                  <ChevronDown className="size-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-52 p-1">
                <div className="px-2 py-1.5 text-[0.6875rem] text-muted-foreground">打开项目</div>
                {apps.map((app) => (
                  <button
                    key={app.id}
                    type="button"
                    onClick={() => chooseApp(app.id)}
                    className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-secondary"
                  >
                    <span className="flex-1">{app.name}</span>
                    {preferredApp === app.id && <span className="text-primary">默认</span>}
                  </button>
                ))}
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  onClick={() => void copyPath()}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-secondary"
                >
                  <Copy className="size-3.5" />
                  {copied ? '已复制路径' : '复制项目路径'}
                </button>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>
    </div>
  )
}
