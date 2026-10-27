import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  Bell,
  Check,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  Clock,
  FileText,
  Folder,
  ListFilter,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  Square,
  Trash2,
} from 'lucide-react'
import type { AppProject, HostApi, SessionRef } from '@pi-meme/contracts/app-host'
import type { ScheduleConfiguration, ScheduledTask, ScheduleRun } from '@pi-meme/contracts/schedules'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { Input } from '@pi-meme/ui/components/ui/input'
import { cn } from '@pi-meme/ui/lib/utils'
import { describeRule, formatScheduleTime } from '../shared/rules'
import type { useSchedules } from './use-schedules'
import { TaskDialog, type ScheduleModelPicker } from './task-dialog'

const templates = [
  {
    name: '项目周报',
    description: '回顾本周进展，整理变更、问题与下一步。',
    prompt:
      '查看当前项目最近一周的提交和代码变更，用中文总结已完成的工作、尚未解决的问题，以及值得优先推进的下一步。请给出相关文件或提交作为依据。',
    weekly: true,
    icon: FileText,
  },
  {
    name: '待办回顾',
    description: '整理项目中的待办，列出需要关注的事项。',
    prompt: '检查当前项目中的待办标记和项目文档，整理尚未完成的事项，按优先级列出建议处理的任务，并注明来源文件。',
    icon: CheckCheck,
  },
  {
    name: '依赖检查',
    description: '检查依赖与项目配置，汇总需要处理的问题。',
    prompt:
      '只读检查当前项目的依赖和配置，整理已确认的问题及其影响，给出可执行的检查命令和修改建议。不要自动安装依赖或修改文件。',
    weekly: true,
    icon: Folder,
  },
  {
    name: '每日提醒',
    description: '按时提醒，为每天留一段回顾和整理的时间。',
    prompt: '提醒我休息片刻、喝水，并回顾今天最需要推进的一件事。请用简短的中文回复。',
    icon: Bell,
  },
]
const statusLabels: Record<ScheduleRun['status'], string> = {
  starting: '准备中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
  cancelled: '已停止',
  skipped: '已跳过',
}
const thinkingLevelLabels: Record<ScheduleConfiguration['thinkingLevel'], string> = {
  off: '关闭',
  minimal: '极小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}
const running = (run?: ScheduleRun) => run?.status === 'running' || run?.status === 'starting'
const mutation = () => ({ idempotencyKey: crypto.randomUUID() })

export function SchedulesPage({
  host,
  state,
  selectedId,
  onSelect,
  location,
  locationLabel,
  defaults,
  plugins,
  renderModelPicker,
  renderAccessSelector,
  onOpenSession,
}: {
  host: HostApi
  state: ReturnType<typeof useSchedules>
  selectedId?: string
  onSelect: (taskId?: string) => void
  location: ReactNode
  locationLabel: string
  defaults: ScheduleConfiguration
  plugins: Array<{ id: string; name: string }>
  renderModelPicker: ScheduleModelPicker
  renderAccessSelector: ScheduleModelPicker
  onOpenSession: (ref: SessionRef) => Promise<void>
}) {
  const { tasks, connected, supported, loading } = state
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const disclosureId = useId()
  const [collapsed, setCollapsed] = useState(new Set<string>())
  const [dialog, setDialog] = useState<{ task?: ScheduledTask; template?: (typeof templates)[number] }>()
  const [deleting, setDeleting] = useState<ScheduledTask>()
  const [projects, setProjects] = useState<AppProject[]>([])
  const [records, setRecords] = useState<Record<string, ScheduleRun[]>>({})
  const [recordsLoading, setRecordsLoading] = useState(false)
  const [hasMore, setHasMore] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState(new Set<string>())
  const [pending, setPending] = useState(new Set<string>())
  const pendingActions = useRef(new Set<string>())
  const [error, setError] = useState('')
  const epoch = useRef(0)
  const selected = tasks.find((task) => task.taskId === selectedId)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const disabled = !connected || supported !== true
  const runs = selected ? (records[selected.taskId] ?? []) : []
  useEffect(() => {
    if (!connected || supported !== true) return
    let active = true
    void host.projects
      .list()
      .then((result) => {
        if (active) setProjects(result)
      })
      .catch((cause) => {
        if (active) setError(String(cause))
      })
    return () => {
      active = false
    }
  }, [host, connected, supported])
  const lastRunSignature = JSON.stringify([selected?.lastRun, selected?.activeRun])
  useEffect(() => {
    if (!selectedId || disabled) return
    const id = ++epoch.current
    setRecordsLoading(true)
    const task = selectedRef.current
    if (!task) {
      setRecordsLoading(false)
      return
    }
    void host.schedules
      .runs(task)
      .then((result) => {
        if (id !== epoch.current) return
        setRecords((values) => ({ ...values, [task.taskId]: result }))
        setHasMore((values) => ({ ...values, [task.taskId]: result.length === 50 }))
      })
      .catch((cause) => {
        if (id === epoch.current) setError(String(cause))
      })
      .finally(() => {
        if (id === epoch.current) setRecordsLoading(false)
      })
    return () => {
      epoch.current++
    }
  }, [host, selectedId, disabled, lastRunSignature, selected?.unreadCount])
  async function action(key: string, work: () => Promise<unknown>) {
    if (pendingActions.current.has(key)) return
    pendingActions.current.add(key)
    setPending(new Set(pendingActions.current))
    setError('')
    try {
      await work()
      await state.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      pendingActions.current.delete(key)
      setPending(new Set(pendingActions.current))
    }
  }
  async function read(task: ScheduledTask, run: ScheduleRun) {
    if (!run.unread || disabled) return
    await host.schedules.markRead(task, run.runId, mutation())
    setRecords((values) => ({
      ...values,
      [task.taskId]: (values[task.taskId] ?? []).map((item) =>
        item.runId === run.runId ? { ...item, unread: false } : item,
      ),
    }))
    await state.refresh()
  }
  const search = query.trim().toLocaleLowerCase()
  const visible = tasks.filter(
    (task) =>
      (filter === 'all' || task.status === filter) &&
      (!search || `${task.name}\n${task.prompt}`.toLocaleLowerCase().includes(search)),
  )
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="content-frame bg-background">
          <aside
            aria-label="定时任务列表"
            className={cn(
              'flex w-full shrink-0 flex-col border-r border-border/60 bg-secondary/25 md:w-[280px]',
              selectedId && 'hidden md:flex',
            )}
          >
            <div className="flex h-14 shrink-0 items-center justify-between px-5">
              <h1 className="text-base font-semibold">定时任务</h1>
              <div className="flex items-center gap-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="筛选任务"
                      className="size-7 text-muted-foreground"
                    >
                      <ListFilter className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" side="bottom">
                    <p className="px-2.5 py-2 text-xs text-muted-foreground">任务状态</p>
                    <DropdownMenuRadioGroup value={filter} onValueChange={setFilter}>
                      {[
                        ['all', '全部任务'],
                        ['active', '活跃'],
                        ['paused', '已暂停'],
                        ['completed', '已结束'],
                      ].map(([value, label]) => (
                        <DropdownMenuRadioItem key={value} value={value}>
                          {label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="搜索任务"
                  className="size-7 text-muted-foreground"
                  onClick={() => document.getElementById('schedule-search')?.focus()}
                >
                  <Search className="size-4" />
                </Button>
              </div>
            </div>
            <div className="px-4 pb-3">{location}</div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setDialog({})}
              className="mx-3 mb-3 flex h-10 items-center gap-2 rounded-xl px-3 text-sm text-foreground transition-colors hover:bg-secondary/80 disabled:opacity-40"
            >
              <Plus className="size-4 text-muted-foreground" />
              新建任务
            </button>
            <div className="px-4 pb-3">
              <Input
                id="schedule-search"
                aria-label="搜索定时任务"
                placeholder="搜索任务"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-8 rounded-lg border-border/50 bg-transparent text-xs shadow-none"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-5" aria-busy={loading}>
              {(['active', 'paused', 'completed'] as const).map((status) => {
                const items = visible
                  .filter((task) => task.status === status)
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                if (!items.length) return null
                const closed = collapsed.has(status)
                return (
                  <div key={status} className="mb-3">
                    <button
                      type="button"
                      aria-expanded={!closed}
                      aria-controls={`${disclosureId}-${status}`}
                      onClick={() =>
                        setCollapsed((values) => {
                          const next = new Set(values)
                          if (next.has(status)) next.delete(status)
                          else next.add(status)
                          return next
                        })
                      }
                      className="flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground"
                    >
                      {status === 'active' ? '活跃' : status === 'paused' ? '已暂停' : '已结束'}
                      <ChevronDown
                        aria-hidden="true"
                        className={cn(
                          'size-3 transition-transform duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                          closed && '-rotate-90',
                        )}
                      />
                      <span className="ml-1 text-muted-foreground/50">{items.length}</span>
                    </button>
                    <div
                      id={`${disclosureId}-${status}`}
                      aria-hidden={closed}
                      inert={closed}
                      className={cn(
                        'grid transition-[grid-template-rows,opacity] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                        closed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
                      )}
                    >
                      <div className="min-h-0 overflow-hidden">
                        {items.map((task) => (
                          <button
                            type="button"
                            key={task.taskId}
                            onClick={() => onSelect(task.taskId)}
                            aria-current={selectedId === task.taskId ? 'page' : undefined}
                            className={cn(
                              'group mb-1 flex w-full items-start gap-2 rounded-xl px-3 py-3 text-left transition-colors hover:bg-secondary/70',
                              selectedId === task.taskId && 'bg-secondary',
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium">{task.name}</span>
                                {task.unreadCount > 0 && (
                                  <span
                                    aria-label={`${task.unreadCount} 条未读运行记录`}
                                    className="size-1.5 shrink-0 rounded-full bg-blue-500"
                                  />
                                )}
                              </div>
                              <p className="mt-1 truncate text-xs text-muted-foreground">
                                {running(task.activeRun)
                                  ? '正在运行'
                                  : task.status === 'paused'
                                    ? '已暂停'
                                    : task.nextRunAt
                                      ? `${formatScheduleTime(task.nextRunAt, task.rule.timeZone)} · ${describeRule(task.rule)}`
                                      : describeRule(task.rule)}
                              </p>
                              {task.lastRun && !running(task.activeRun) && (
                                <p
                                  className={cn(
                                    'mt-1 truncate text-[11px] text-muted-foreground/65',
                                    task.lastRun.status === 'failed' && 'text-destructive/80',
                                  )}
                                >
                                  最近{statusLabels[task.lastRun.status]}
                                </p>
                              )}
                            </div>
                            {running(task.activeRun) ? (
                              <Loader2 className="mt-1 size-3.5 shrink-0 animate-spin text-muted-foreground" />
                            ) : task.lastRun?.status === 'failed' ? (
                              <CircleAlert className="mt-1 size-3.5 shrink-0 text-destructive" />
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              })}
              {!visible.length && (
                <p className="px-3 py-6 text-xs text-muted-foreground">
                  {loading ? '正在读取任务…' : search || filter !== 'all' ? '没有匹配的任务' : '创建任务后会显示在这里'}
                </p>
              )}
            </div>
            <div className="shrink-0 border-t border-border/40 px-5 py-3 text-[11px] leading-5 text-muted-foreground/60">
              由执行 Host 运行任务
              <br />
              休眠或离线期间错过的执行将跳过
            </div>
          </aside>
          <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', !selectedId && 'hidden md:flex')}>
            {(error || state.error || !connected || supported === false) && (
              <div
                role="alert"
                className="m-5 flex items-center gap-3 rounded-xl border border-border/70 bg-secondary/40 px-4 py-3 text-sm"
              >
                <CircleAlert className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 break-words">
                  {!connected
                    ? '执行 Host 未连接。已加载的任务仍可查看，恢复连接后可继续管理。'
                    : supported === false
                      ? '当前 Host 不支持定时任务，请更新 Host。'
                      : error || state.error}
                </span>
                {connected && supported !== false && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setError('')
                      void state.refresh()
                    }}
                  >
                    重试
                  </Button>
                )}
              </div>
            )}
            {selected ? (
              <>
                <div className="flex shrink-0 items-center gap-3 border-b border-border/50 px-5 py-4 sm:px-8">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="返回任务列表"
                    className="md:hidden"
                    onClick={() => onSelect(undefined)}
                  >
                    <ArrowLeft className="size-4" />
                  </Button>
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary">
                    <Clock className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-semibold">{selected.name}</h2>
                    <span className="text-xs text-muted-foreground">
                      {selected.status === 'active' ? '活跃' : selected.status === 'paused' ? '已暂停' : '已结束'}
                    </span>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="任务操作">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" side="bottom">
                      <DropdownMenuItem disabled={disabled} onClick={() => setDialog({ task: selected })}>
                        <Settings2 className="size-4" />
                        编辑任务
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={disabled || running(selected.activeRun)}
                        onClick={() => setDeleting(selected)}
                        className="text-destructive"
                      >
                        <Trash2 className="size-4" />
                        删除任务
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="mx-auto w-full max-w-[880px] px-5 py-8 sm:px-10 sm:py-10">
                    <div className="mb-8 flex flex-wrap items-start justify-between gap-5">
                      <div>
                        <p className="mb-2 text-xs text-muted-foreground">下次运行</p>
                        <p className="text-xl font-medium tracking-tight">
                          {selected.status === 'paused'
                            ? '任务已暂停'
                            : selected.nextRunAt
                              ? formatScheduleTime(selected.nextRunAt, selected.rule.timeZone)
                              : '暂无后续安排'}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {describeRule(selected.rule)} · {selected.rule.timeZone}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="rounded-full"
                          disabled={disabled || pending.has('edit')}
                          onClick={() => setDialog({ task: selected })}
                        >
                          <Settings2 className="size-3.5" />
                          编辑
                        </Button>
                        {selected.status !== 'completed' && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="rounded-full"
                            disabled={disabled || pending.has('toggle')}
                            onClick={() =>
                              void action('toggle', () =>
                                selected.status === 'active'
                                  ? host.schedules.pause(selected, mutation())
                                  : host.schedules.resume(selected, mutation()),
                              )
                            }
                          >
                            {pending.has('toggle') ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : selected.status === 'active' ? (
                              <Pause className="size-3.5" />
                            ) : (
                              <Play className="size-3.5" />
                            )}
                            {selected.status === 'active' ? '暂停' : '恢复'}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          className="rounded-full"
                          disabled={disabled || pending.has('run') || pending.has('stop')}
                          onClick={() =>
                            void action(running(selected.activeRun) ? 'stop' : 'run', () =>
                              running(selected.activeRun)
                                ? host.schedules.stopRun(selected, mutation())
                                : host.schedules.runNow(selected, mutation()),
                            )
                          }
                        >
                          {pending.has('run') || pending.has('stop') ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : running(selected.activeRun) ? (
                            <Square className="size-3.5" />
                          ) : (
                            <Play className="size-3.5" />
                          )}
                          {running(selected.activeRun) ? '停止本次运行' : '立即运行'}
                        </Button>
                      </div>
                    </div>
                    {selected.error && (
                      <div className="mb-6 rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-sm">
                        <p>{selected.error}</p>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={disabled || pending.has('reset')}
                          className="mt-3"
                          onClick={() => void action('reset', () => host.schedules.resetSession(selected, mutation()))}
                        >
                          重新建立专属聊天
                        </Button>
                      </div>
                    )}
                    <div className="rounded-[20px] border border-border/60 bg-secondary/15 px-5 py-5 sm:px-6">
                      <h3 className="text-xs font-medium text-muted-foreground">执行说明</h3>
                      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 select-text">
                        {selected.prompt}
                      </p>
                      <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 border-t border-border/50 pt-4 text-xs text-muted-foreground">
                        <span>
                          {selected.project
                            ? (projects.find((project) => project.projectId === selected.project?.projectId)?.name ??
                              '项目不可用')
                            : '独立工作目录'}
                        </span>
                        <span>{selected.newSessionEachRun ? '每次开启新聊天' : '持续使用专属聊天'}</span>
                        <span>{selected.configuration.model.name ?? selected.configuration.model.id}</span>
                        <span>
                          {selected.notification === 'all'
                            ? '每次完成提醒'
                            : selected.notification === 'failures'
                              ? '仅失败时提醒'
                              : '通知已关闭'}
                        </span>
                      </div>
                    </div>
                    <div className="mb-4 mt-9 flex items-center justify-between">
                      <h3 className="text-sm font-semibold">运行记录</h3>
                      <span className="text-xs text-muted-foreground">
                        {recordsLoading ? '正在更新…' : '按运行时间排序'}
                      </span>
                    </div>
                    <div className="space-y-3">
                      {runs.map((run) => (
                        <div key={run.runId} className="overflow-hidden rounded-2xl border border-border/60">
                          <button
                            type="button"
                            aria-expanded={expanded.has(run.runId)}
                            aria-controls={`${disclosureId}-${run.runId}`}
                            onClick={() => {
                              setExpanded((values) => {
                                const next = new Set(values)
                                if (next.has(run.runId)) next.delete(run.runId)
                                else next.add(run.runId)
                                return next
                              })
                              if (!expanded.has(run.runId))
                                void read(selected, run).catch((cause) => setError(String(cause)))
                            }}
                            className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-secondary/25"
                          >
                            <RunIcon run={run} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 text-sm">
                                <span>{formatScheduleTime(run.startedAt, selected.rule.timeZone)}</span>
                                {run.unread && <span className="size-1.5 rounded-full bg-blue-500" />}
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {run.trigger === 'manual' ? '手动运行' : '定时运行'}
                                {run.finishedAt &&
                                  ` · ${Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000))} 秒`}
                                {run.missedCount && run.missedCount > 1 ? ` · 合并 ${run.missedCount} 次错过` : ''}
                              </p>
                            </div>
                            <span
                              className={cn(
                                'shrink-0 rounded-full bg-secondary px-2.5 py-1 text-[11px] text-muted-foreground',
                                run.status === 'failed' && 'bg-destructive/10 text-destructive',
                              )}
                            >
                              {run.needsInput ? '需要处理' : statusLabels[run.status]}
                            </span>
                            <ChevronDown
                              aria-hidden="true"
                              className={cn(
                                'size-3.5 shrink-0 text-muted-foreground transition-transform duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                                expanded.has(run.runId) && 'rotate-180',
                              )}
                            />
                          </button>
                          <div
                            id={`${disclosureId}-${run.runId}`}
                            aria-hidden={!expanded.has(run.runId)}
                            inert={!expanded.has(run.runId)}
                            className={cn(
                              'grid transition-[grid-template-rows,opacity] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                              expanded.has(run.runId) ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
                            )}
                          >
                            <div className="min-h-0 overflow-hidden">
                              <div className="border-t border-border/50 bg-secondary/10 px-5 py-4">
                                {run.error && (
                                  <p
                                    className={cn(
                                      'mb-3 whitespace-pre-wrap break-words text-sm leading-6 select-text',
                                      run.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                                    )}
                                  >
                                    {run.error}
                                  </p>
                                )}
                                <p className="text-xs leading-6 text-muted-foreground">
                                  {run.configuration.model.name ?? run.configuration.model.id} ·{' '}
                                  {thinkingLevelLabels[run.configuration.thinkingLevel]}
                                </p>
                                <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground select-text">
                                  {run.prompt}
                                </p>
                                {run.session && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={disabled || pending.has(run.runId)}
                                    className="mt-4 rounded-full"
                                    onClick={() =>
                                      void action(run.runId, async () => {
                                        await read(selected, run)
                                        await onOpenSession(run.session!)
                                      })
                                    }
                                  >
                                    {run.needsInput ? '打开聊天处理请求' : '打开聊天'}
                                    <ArrowUpRight className="size-3.5" />
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    {!runs.length && (
                      <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border/60 py-12 text-center">
                        <Clock className="size-6 text-muted-foreground/50" />
                        <p className="text-sm text-muted-foreground">
                          {recordsLoading ? '正在读取运行记录…' : '还没有运行记录'}
                        </p>
                        <p className="px-5 text-xs text-muted-foreground/60">
                          任务会按安排运行，也可以点击「立即运行」。
                        </p>
                      </div>
                    )}
                    {hasMore[selected.taskId] && (
                      <Button
                        variant="ghost"
                        className="mt-4 w-full text-xs text-muted-foreground"
                        disabled={disabled || pending.has('more')}
                        onClick={() =>
                          void action('more', async () => {
                            const result = await host.schedules.runs(selected, { offset: runs.length, limit: 50 })
                            setRecords((values) => ({
                              ...values,
                              [selected.taskId]: [...(values[selected.taskId] ?? []), ...result],
                            }))
                            setHasMore((values) => ({ ...values, [selected.taskId]: result.length === 50 }))
                          })
                        }
                      >
                        加载更多记录
                      </Button>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-7 py-12">
                <div className="w-full max-w-[660px] pb-8">
                  <div className="mb-10 text-center">
                    <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-[18px] bg-secondary/75">
                      <Clock className="size-7 text-foreground/80" strokeWidth={1.5} />
                    </div>
                    <h2 className="text-xl font-semibold tracking-tight">安排任务</h2>
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                      把需要重复处理的事交给 Pi，按你的时间安排运行。
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    {templates.map((template) => (
                      <button
                        type="button"
                        key={template.name}
                        disabled={disabled}
                        onClick={() => setDialog({ template })}
                        className="group flex min-h-28 items-center gap-4 rounded-[20px] border border-border/60 bg-transparent px-5 py-5 text-left transition-colors hover:border-border hover:bg-secondary/30 disabled:opacity-40"
                      >
                        <template.icon
                          className="size-5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                          strokeWidth={1.5}
                        />
                        <div>
                          <h3 className="text-sm font-medium">{template.name}</h3>
                          <p className="mt-2 text-xs leading-6 text-muted-foreground">{template.description}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                  <p className="mt-6 text-center text-xs text-muted-foreground/55">从一个示例开始，或在左侧新建任务</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {dialog && (
        <TaskDialog
          task={dialog.task}
          template={dialog.template}
          projects={projects}
          defaults={defaults}
          locationLabel={locationLabel}
          plugins={plugins}
          renderModelPicker={renderModelPicker}
          renderAccessSelector={renderAccessSelector}
          onClose={() => setDialog(undefined)}
          onSave={async (input) => {
            const result = dialog.task
              ? await host.schedules.update(dialog.task, input, mutation())
              : await host.schedules.create(input, mutation())
            await state.refresh()
            onSelect(result.taskId)
          }}
        />
      )}
      {deleting && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !pending.has('delete')) setDeleting(undefined)
          }}
        >
          <DialogContent className="rounded-2xl">
            <DialogTitle>删除「{deleting.name}」？</DialogTitle>
            <DialogDescription>任务安排和运行记录将被删除，已生成的聊天会保留。</DialogDescription>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={pending.has('delete')} onClick={() => setDeleting(undefined)}>
                取消
              </Button>
              <Button
                variant="destructive"
                disabled={pending.has('delete')}
                onClick={() =>
                  void action('delete', async () => {
                    await host.schedules.delete(deleting, mutation())
                    setDeleting(undefined)
                    onSelect(undefined)
                  })
                }
              >
                {pending.has('delete') && <Loader2 className="size-4 animate-spin" />}删除任务
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

function RunIcon({ run }: { run: ScheduleRun }) {
  const className = 'size-4 shrink-0 text-muted-foreground'
  if (running(run)) return <Loader2 className={cn(className, 'animate-spin')} />
  if (run.status === 'completed') return <Check className={className} />
  if (run.status === 'failed') return <CircleAlert className={cn(className, 'text-destructive')} />
  if (run.status === 'cancelled') return <Square className={className} />
  return <Clock className={className} />
}
