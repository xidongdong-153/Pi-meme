import { useState } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FolderOpen,
  GitCompare,
  GitFork,
  Network,
  PanelLeft,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react'
import type { ProjectApp } from '@pi-meme/contracts/desktop'
import type { RightSidebarTab } from './right-sidebar'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'

const appNames: Record<ProjectApp['id'], string> = {
  finder: 'Finder',
  vscode: 'Visual Studio Code',
  cursor: 'Cursor',
  zed: 'Zed',
}
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.userAgent)

export function AppHeader({
  nativeWindow,
  canOpenProject,
  loadProjectApps,
  sidebarOpen,
  onToggleSidebar,
  sidebarWidth,
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
  onShowGit,
  rightPaneOpen,
  onToggleRightPane,
  rightTab,
  onShowSessionTree,
  forkedFrom,
  onOpenForkSource,
}: {
  nativeWindow: boolean
  canOpenProject: boolean
  loadProjectApps: () => Promise<ProjectApp[]>
  sidebarOpen: boolean
  onToggleSidebar: () => void
  sidebarWidth: number
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
  onShowGit: () => void
  rightPaneOpen: boolean
  onToggleRightPane: () => void
  rightTab: RightSidebarTab
  /** 打开右侧栏并切到 Session Tree 标签 */
  onShowSessionTree: () => void
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
    <header className="flex h-10 items-center justify-between border-b border-border/70 pr-3 window-drag bg-background/80 backdrop-blur-md select-none shrink-0 z-30">
      <div className="flex h-full items-center min-w-0 flex-1">
        {/* 侧边栏对应顶部区域 */}
        <div
          className={cn(
            'flex h-full items-center min-w-0 no-drag shrink-0',
            sidebarOpen ? 'justify-between px-3' : 'gap-1.5 px-3',
          )}
          style={sidebarOpen ? { width: sidebarWidth } : undefined}
        >
          <div className="flex items-center gap-1.5 min-w-0 shrink-0">
            {nativeWindow && isMac && <div className="w-[74px] shrink-0" aria-hidden="true" />}
            <div className="flex items-center gap-0.5 text-muted-foreground/30 shrink-0" aria-hidden="true">
              <Button
                variant="ghost"
                size="icon-sm"
                disabled
                aria-label="后退"
                className="size-6 p-0 disabled:opacity-30"
              >
                <ChevronLeft className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled
                aria-label="前进"
                className="size-6 p-0 disabled:opacity-30"
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onToggleSidebar}
                aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
                aria-expanded={sidebarOpen}
                className="size-7 text-muted-foreground hover:text-foreground shrink-0"
              >
                <PanelLeft className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{sidebarOpen ? '收起侧边栏' : '展开侧边栏'}</TooltipContent>
          </Tooltip>
        </div>

        {/* 折叠图标右侧的分割短线：在展开时正好与侧栏右侧对齐 */}
        <div className="flex h-full items-center shrink-0 -ml-px">
          <div className="h-3.5 w-px bg-border/60 shrink-0" />
        </div>

        {/* 主面板对应顶部区域（项目目录与会话名称） */}
        <div className="flex items-center gap-1.5 min-w-0 no-drag flex-1 px-3">
          <button
            type="button"
            disabled={busy}
            title={directoryDisabledReason || cwd}
            aria-label="在顶栏选择项目"
            onClick={(event) => onDirectory(event.currentTarget)}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-foreground hover:bg-secondary/70 transition-colors max-w-[180px] truncate disabled:opacity-50"
          >
            <FolderOpen className="size-3.5 text-primary shrink-0" />
            <span className="truncate">{project}</span>
          </button>
          <ChevronRight className="size-3 text-muted-foreground/50 shrink-0" />
          <span className="text-xs font-medium text-foreground/90 truncate max-w-[360px]" title={sessionName || title}>
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
      </div>

      <div className="flex items-center gap-1.5 no-drag shrink-0">
        <div
          className={cn(
            'flex h-7 items-center rounded-md text-muted-foreground transition-colors',
            menuOpen ? 'bg-secondary/70 text-foreground' : 'hover:bg-secondary/70 hover:text-foreground',
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
                <FolderOpen className="size-4" />
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

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onShowSessionTree}
              aria-label="查看 Session Tree"
              aria-expanded={rightPaneOpen && rightTab === 'session-tree'}
              className={cn(
                'size-7 text-muted-foreground hover:text-foreground',
                rightPaneOpen && rightTab === 'session-tree' && 'bg-secondary/70 text-foreground',
              )}
            >
              <Network className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">查看 Session Tree</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onShowGit}
              aria-label="查看 Git 变更"
              aria-expanded={rightPaneOpen && rightTab === 'git'}
              className={cn(
                'size-7 text-muted-foreground hover:text-foreground',
                rightPaneOpen && rightTab === 'git' && 'bg-secondary/70 text-foreground',
              )}
            >
              <GitCompare className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">查看 Git 变更</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggleRightPane}
              aria-label={rightPaneOpen ? '收起右侧栏' : '展开右侧栏'}
              aria-expanded={rightPaneOpen}
              className={cn(
                'size-7 text-muted-foreground hover:text-foreground',
                rightPaneOpen && 'bg-secondary/70 text-foreground',
              )}
            >
              {rightPaneOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{rightPaneOpen ? '收起右侧栏' : '展开右侧栏'}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}
