import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Folder,
  FolderOpen,
  Loader2,
  Pin,
  Plus,
  Search,
  SquarePen,
} from 'lucide-react'
import type { DesktopBridge, WorkspaceDeletionResult } from '@pi-meme/contracts/desktop'
import type { DesktopProject, PiProjectGroup, PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { cn } from '@pi-meme/ui/lib/utils'
import { SidebarMenus, SidebarMoreMenu, type SidebarMenuBridge } from '@pi-meme/workspace/ui/sidebar/sidebar-menus'
import { formatSessionTitle } from '@pi-meme/workspace/ui/sidebar/session-title'
import { PageHeader, PageHeaderNavigation } from '../layout/page-header'
import { ProjectDialog } from './project-dialog'

type Project = DesktopProject & PiProjectGroup

function updatedTime(value: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时`
  const days = Math.floor(minutes / 1440)
  if (days < 7) return `${days} 天`
  if (days < 30) return `${Math.floor(days / 7)} 周`
  return `${Math.floor(days / 30)} 个月`
}

export function ProjectsPage({
  bridge,
  sessions,
  nativeWindow,
  canOpenProject,
  rail,
  notice,
  onDismiss,
  onCreate,
  onChanged,
  onDeleted,
  onNewSession,
  onSwitchSession,
  onTogglePin,
  onPrefetchSession,
}: {
  bridge: SidebarMenuBridge & Pick<DesktopBridge, 'getProjects' | 'pickProjectDirectory' | 'onSessionsChanged'>
  sessions: PiSessionsSnapshot | null
  nativeWindow: boolean
  canOpenProject: boolean
  rail: ReactNode
  notice?: ReactNode
  onDismiss: () => void
  onCreate: (input: { cwd: string; name: string }) => Promise<void>
  onChanged: () => Promise<void>
  onDeleted: (result: WorkspaceDeletionResult) => Promise<void>
  onNewSession: (cwd: string) => Promise<void>
  onSwitchSession: (path: string) => Promise<void>
  onTogglePin: (cwd: string) => Promise<void>
  onPrefetchSession: (path: string) => void
}) {
  const [projects, setProjects] = useState<DesktopProject[] | null>(null)
  const [query, setQuery] = useState('')
  const [descending, setDescending] = useState(true)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const request = useRef(0)
  const refresh = useCallback(async () => {
    const id = ++request.current
    setLoading(true)
    setError('')
    try {
      const result = await bridge.getProjects()
      if (id === request.current) setProjects(result)
    } catch (cause) {
      if (id === request.current) setError(`无法读取项目：${String(cause)}`)
    } finally {
      if (id === request.current) setLoading(false)
    }
  }, [bridge])
  useEffect(() => {
    void refresh()
    const off = bridge.onSessionsChanged(() => void refresh())
    return () => {
      request.current++
      off()
    }
  }, [bridge, refresh])

  const search = query.trim().toLocaleLowerCase()
  const groups = new Map(sessions?.projects.map((group) => [group.cwd, group]))
  const pinned = new Set(sessions?.pinnedPaths ?? [])
  const registered = projects ?? (sessions?.projects ?? []).map((group) => ({ ...group, lastSelectedAt: '' }))
  const visible = registered
    .filter((project) => [project.name, project.cwd].some((value) => value.toLocaleLowerCase().includes(search)))
    .map((project): Project => {
      const group = groups.get(project.cwd)
      const entries = [...(group?.sessions ?? [])].sort((a, b) => b.modified.localeCompare(a.modified))
      return {
        ...project,
        sessions: entries,
        sessionCount: entries.length,
        lastModified:
          [group?.lastModified ?? '', project.lastSelectedAt, entries[0]?.modified ?? ''].sort().at(-1) ?? '',
      }
    })
    .sort(
      (a, b) =>
        Number(pinned.has(b.cwd)) - Number(pinned.has(a.cwd)) ||
        (descending ? b.lastModified.localeCompare(a.lastModified) : a.lastModified.localeCompare(b.lastModified)) ||
        a.name.localeCompare(b.name, 'zh-CN'),
    )

  async function changed() {
    await Promise.all([refresh(), onChanged()])
  }

  return (
    <section
      aria-label="项目页面"
      className="workspace-panes flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-secondary"
    >
      <PageHeader>
        <PageHeaderNavigation nativeWindow={nativeWindow} back={{ label: '返回聊天', onClick: onDismiss }} />
      </PageHeader>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {rail}
        <div className="content-frame bg-background">
          <SidebarMenus
            bridge={bridge}
            canOpenProject={canOpenProject}
            pinnedPaths={sessions?.pinnedPaths ?? []}
            onNewSession={(cwd) => void onNewSession(cwd)}
            onTogglePin={(cwd) => void onTogglePin(cwd)}
            onChanged={changed}
            onDeleted={async (result) => {
              await onDeleted(result)
              await refresh()
            }}
          >
            <div className="theme-workspace min-h-0 min-w-0 flex-1 overflow-y-auto bg-background px-5 py-7 sm:px-8 lg:px-12 lg:py-9">
              <div className="mb-6 flex flex-wrap items-center justify-between gap-4 sm:mb-8">
                <h1 className="text-2xl font-semibold tracking-tight">项目</h1>
                <div className="no-drag flex min-w-0 items-center gap-3">
                  <div className="relative w-44 sm:w-60">
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
                    />
                    <Input
                      aria-label="搜索项目"
                      placeholder="搜索项目"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      className="h-9 rounded-full bg-transparent pl-9"
                    />
                  </div>
                  <Button onClick={() => setCreating(true)} className="h-9 rounded-full px-4">
                    <Plus className="size-4" />
                    创建
                  </Button>
                </div>
              </div>
              {notice}
              {error && (
                <div role="alert" className="mb-4 flex items-center gap-3 text-sm text-destructive">
                  <span className="min-w-0 flex-1 break-all">{error}</span>
                  <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>
                    重试
                  </Button>
                </div>
              )}
              <div className="flex items-center gap-3 border-b border-border/60 px-3 pb-3 text-xs text-muted-foreground">
                <span className="min-w-0 flex-1">名称</span>
                <button
                  type="button"
                  onClick={() => setDescending((value) => !value)}
                  aria-label={descending ? '按更新时间从早到晚排序' : '按更新时间从晚到早排序'}
                  className="flex w-24 shrink-0 items-center gap-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-28"
                >
                  已更新{descending ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />}
                </button>
                <span className="w-24 shrink-0 sm:w-28" aria-hidden="true" />
              </div>
              <div aria-label="项目列表" aria-busy={loading}>
                {visible.map((project) => (
                  <ProjectRow
                    key={project.cwd}
                    project={project}
                    pinned={pinned.has(project.cwd)}
                    onNewSession={onNewSession}
                    onSwitchSession={onSwitchSession}
                    onTogglePin={onTogglePin}
                    onPrefetchSession={onPrefetchSession}
                    onError={setError}
                  />
                ))}
              </div>
              {!visible.length && (
                <div role="status" className="flex flex-col items-center gap-3 py-20 text-sm text-muted-foreground">
                  {loading ? (
                    <Loader2 className="size-6 animate-spin" />
                  ) : (
                    <Folder className="size-8 text-muted-foreground/60" />
                  )}
                  <p>
                    {loading
                      ? '正在读取项目…'
                      : search
                        ? '没有匹配的项目'
                        : error
                          ? '项目列表暂时不可用'
                          : '还没有项目'}
                  </p>
                  {!loading && !search && !error && (
                    <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                      创建项目
                    </Button>
                  )}
                </div>
              )}
            </div>
            {creating && (
              <ProjectDialog
                pickDirectory={bridge.pickProjectDirectory}
                onDismiss={() => setCreating(false)}
                onCreate={async (input) => {
                  await onCreate(input)
                  void changed().catch((cause) => setError(`项目已创建，刷新失败：${String(cause)}`))
                }}
              />
            )}
          </SidebarMenus>
        </div>
      </div>
    </section>
  )
}

function ProjectRow({
  project,
  pinned,
  onNewSession,
  onSwitchSession,
  onTogglePin,
  onPrefetchSession,
  onError,
}: {
  project: Project
  pinned: boolean
  onNewSession: (cwd: string) => Promise<void>
  onSwitchSession: (path: string) => Promise<void>
  onTogglePin: (cwd: string) => Promise<void>
  onPrefetchSession: (path: string) => void
  onError: (message: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [pending, setPending] = useState<string>()
  const entries = showAll ? project.sessions : project.sessions.slice(0, 10)

  async function run(key: string, work: () => Promise<void>) {
    setPending(key)
    try {
      await work()
    } catch (cause) {
      onError(String(cause))
    } finally {
      setPending((value) => (value === key ? undefined : value))
    }
  }

  return (
    <div className="border-b border-border/60" data-project-cwd={project.cwd}>
      <div className="group relative isolate z-10 flex min-w-0 items-center gap-3 px-3 before:pointer-events-none before:absolute before:-inset-x-3 before:-inset-y-px before:-z-10 before:rounded-xl before:bg-secondary before:opacity-0 before:transition-opacity hover:before:opacity-100 focus-within:before:opacity-100">
        <button
          type="button"
          title={project.cwd}
          aria-label={`${expanded ? '收起项目' : '展开项目'}：${project.name}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-4 rounded-lg py-5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? (
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-medium">{project.name}</span>
          {project.unavailable && <span className="shrink-0 text-xs text-muted-foreground">目录不可用</span>}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground opacity-0 transition-[transform,opacity] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100',
              expanded && 'rotate-90 opacity-100',
            )}
          />
        </button>
        <time
          dateTime={project.lastModified || undefined}
          title={project.lastModified ? new Date(project.lastModified).toLocaleString() : undefined}
          className="w-24 shrink-0 text-xs text-muted-foreground sm:w-28"
        >
          {updatedTime(project.lastModified)}
        </time>
        <div className="flex w-24 shrink-0 items-center justify-end sm:w-28">
          <SidebarMoreMenu
            target={{ kind: 'project', project }}
            className="flex size-8 items-center justify-center rounded-lg opacity-100 hover:bg-secondary group-focus-within:opacity-100 data-[state=open]:bg-secondary [&_svg]:size-4"
          />
          <button
            type="button"
            title={pinned ? '取消置顶项目' : '置顶项目'}
            aria-label={`${pinned ? '取消置顶项目' : '置顶项目'}：${project.name}`}
            disabled={pending === 'pin'}
            onClick={() => void run('pin', () => onTogglePin(project.cwd))}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <Pin className={cn('size-4', pinned && 'fill-current text-foreground')} />
          </button>
          <button
            type="button"
            title={project.unavailable ? '项目目录不可用' : '新建聊天'}
            aria-label={`在项目中新建聊天：${project.name}`}
            disabled={project.unavailable || pending === 'new'}
            onClick={() => void run('new', () => onNewSession(project.cwd))}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {pending === 'new' ? <Loader2 className="size-4 animate-spin" /> : <SquarePen className="size-4" />}
          </button>
        </div>
      </div>
      <div
        aria-hidden={!expanded}
        inert={!expanded}
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="pb-4 pl-11 pr-3 sm:pl-12">
            {entries.map((session) => (
              <button
                key={session.path}
                type="button"
                disabled={pending === session.path}
                onClick={() => void run(session.path, () => onSwitchSession(session.path))}
                onMouseEnter={() => onPrefetchSession(session.path)}
                onFocus={() => onPrefetchSession(session.path)}
                className="flex w-full min-w-0 items-center gap-3 rounded-lg py-2.5 pl-1 pr-0 text-left text-sm hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate">{formatSessionTitle(session)}</span>
                {(pending === session.path || (session.running && !session.isPaused)) && (
                  <Loader2 aria-label="会话加载中" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                )}
                <time dateTime={session.modified} className="w-24 shrink-0 text-xs text-muted-foreground sm:w-28">
                  {updatedTime(session.modified)}
                </time>
                <span className="w-24 shrink-0 sm:w-28" aria-hidden="true" />
              </button>
            ))}
            {!entries.length && <p className="py-3 text-sm text-muted-foreground">暂无聊天，可点击右侧按钮新建。</p>}
            {project.sessions.length > 10 && (
              <button
                type="button"
                onClick={() => setShowAll((value) => !value)}
                className="rounded px-1 py-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {showAll ? '收起' : '展开显示'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
