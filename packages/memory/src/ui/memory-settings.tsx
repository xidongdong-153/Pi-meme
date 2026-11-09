import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { MemoryEntry, MemoryEntryInput, MemoryJob, MemorySource } from '@pi-meme/contracts/memory'
import type { PiModel } from '@pi-meme/contracts/pi'
import type { UiMessage } from '@pi-meme/contracts/plugin-ui-data'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Textarea } from '@pi-meme/ui/components/ui/textarea'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import { SettingsCard, SettingsGroup, SettingsRow, settingsControlClassName } from '@pi-meme/ui/components/settings'
import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'
import { memoryScopeKey, parseMemoryScope, useMemorySettings } from './use-memory-settings'
import { MemoryEntryPreview } from './memory-entry-preview'

type Editor = { original?: MemoryEntry; input: MemoryEntryInput; baseline: string; epoch: number }
type Confirmation = { kind: 'remove'; entry: MemoryEntry } | { kind: 'clear'; revision: number; count: number }
const modelKey = (value: { provider: string; id: string }) => JSON.stringify([value.provider, value.id])
function readableDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
const jobLabels: Record<MemoryJob['state'], string> = {
  waiting: '等待空闲',
  extracting: '正在提炼',
  consolidating: '正在整合',
  completed: '已完成',
  failed: '学习失败',
  cancelled: '已停止',
  'budget-paused': '预算暂停',
  interrupted: '已中断',
}
const runningJob = (job: MemoryJob) => ['waiting', 'extracting', 'consolidating', 'budget-paused'].includes(job.state)

export function MemorySettings({
  host,
  connected,
  hostLabel,
  currentProjectId,
  models,
  onModels,
  onDirty,
  onSaving,
  discardVersion,
  onOpenSourceSession,
  renderSource,
}: {
  host: HostApi
  connected: boolean
  hostLabel: string
  currentProjectId?: string
  models: PiModel[]
  onModels: () => void
  onDirty: (dirty: boolean) => void
  onSaving: (saving: boolean) => void
  discardVersion: number
  onOpenSourceSession: (source: MemorySource) => Promise<void>
  renderSource: (message: UiMessage) => ReactNode
}) {
  const memory = useMemorySettings(host, connected)
  const [advanced, setAdvanced] = useState(false)
  const [showJobs, setShowJobs] = useState(false)
  const [selected, setSelected] = useState<MemoryEntry>()
  const [latestEntry, setLatestEntry] = useState<MemoryEntry>()
  const [editor, setEditor] = useState<Editor>()
  const [budgetDraft, setBudgetDraft] = useState<string>()
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)
  const [localError, setLocalError] = useState('')
  const [sourceView, setSourceView] = useState<{ source: MemorySource; message?: UiMessage; error?: string }>()
  const [openingSession, setOpeningSession] = useState(false)
  const selectedRequest = useRef(0)
  const sourceRequest = useRef(0)
  const selectedButton = useRef<HTMLButtonElement | null>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  const config = memory.status?.config
  const dirtyBudget = budgetDraft !== undefined && budgetDraft !== String(config?.dailyTokenBudget ?? '')
  const dirty = Boolean(editor && JSON.stringify(editor.input) !== editor.baseline) || dirtyBudget
  const saving = Boolean(memory.busy)
  const budgetValue = budgetDraft ?? String(config?.dailyTokenBudget ?? '')
  const budgetValid =
    Number.isInteger(Number(budgetValue)) && Number(budgetValue) >= 20000 && Number(budgetValue) <= 1000000
  const hasDetail = Boolean(editor || selected)
  const projectName = (id: string) => {
    const project = memory.projects.find((entry) => entry.projectId === id)
    return project ? `${project.name}${project.unavailable ? '（不可用）' : ''}` : `项目 ${id.slice(0, 8)}`
  }
  const scopeName = (entry: Pick<MemoryEntry, 'scope'>) =>
    entry.scope.kind === 'global' ? '通用' : projectName(entry.scope.projectId)
  const jobs = memory.status?.jobs ?? []
  const activeJob = jobs.find(runningJob)
  const failedJob = jobs.find((job) => job.state === 'failed' || job.state === 'interrupted')
  const budget = memory.status?.budget
  const selectedModel = config?.model && models.find((model) => modelKey(model) === modelKey(config.model!))
  const modelUnavailable = Boolean(config?.model && !selectedModel)

  useEffect(() => onDirty(dirty), [dirty, onDirty])
  useEffect(() => onSaving(saving), [saving, onSaving])
  useEffect(
    () => () => {
      onDirty(false)
      onSaving(false)
    },
    [onDirty, onSaving],
  )
  useEffect(() => {
    setEditor(undefined)
    setBudgetDraft(undefined)
    setLatestEntry(undefined)
    setPendingLeave(null)
    setLocalError('')
  }, [discardVersion])
  useEffect(
    () => () => {
      selectedRequest.current++
      sourceRequest.current++
    },
    [],
  )

  function leave(action: () => void) {
    if (saving) return
    if (dirty) setPendingLeave(() => action)
    else action()
  }
  function resetDraft() {
    selectedRequest.current++
    setEditor(undefined)
    setBudgetDraft(undefined)
    setLatestEntry(undefined)
    setLocalError('')
  }
  function closeDetail() {
    leave(() => {
      resetDraft()
      setSelected(undefined)
      requestAnimationFrame(() => {
        const target = selectedButton.current?.isConnected ? selectedButton.current : createButton.current
        target?.focus({ preventScroll: true })
      })
    })
  }
  function beginCreate() {
    leave(() => {
      if (!memory.status) return
      resetDraft()
      const scope =
        parseMemoryScope(memory.filter) ??
        (currentProjectId ? { kind: 'project' as const, projectId: currentProjectId } : { kind: 'global' as const })
      const input: MemoryEntryInput = { title: '', content: '', scope }
      setEditor({ input, baseline: JSON.stringify(input), epoch: memory.status.epoch })
      selectedButton.current = null
      setSelected(undefined)
      setLocalError('')
    })
  }
  function selectEntry(entry: MemoryEntry, button: HTMLButtonElement) {
    leave(() => {
      resetDraft()
      selectedButton.current = button
      setSelected(entry)
      const request = ++selectedRequest.current
      void host.memory?.get(entry.id).then(
        (latest) => {
          if (selectedRequest.current === request) setSelected(latest)
        },
        (cause) => {
          if (selectedRequest.current === request) setLocalError(String(cause))
        },
      )
    })
  }
  function beginEdit() {
    if (!selected || !memory.status) return
    selectedRequest.current++
    setLatestEntry(undefined)
    const input = { title: selected.title, content: selected.content, scope: selected.scope }
    setEditor({ original: selected, input, baseline: JSON.stringify(input), epoch: memory.status.epoch })
    setLocalError('')
  }
  async function reloadLatest() {
    const entry = editor?.original ?? selected
    const request = ++selectedRequest.current
    await memory.reload()
    if (!entry || !connected || !host.memory) return
    try {
      const latest = await host.memory.get(entry.id)
      if (selectedRequest.current !== request) return
      if (editor) setLatestEntry(latest)
      else setSelected(latest)
      setLocalError('')
    } catch (cause) {
      if (selectedRequest.current === request) setLocalError(String(cause))
    }
  }
  function adoptLatest() {
    if (!latestEntry || !memory.status) return
    const latest = latestEntry
    leave(() => {
      const input = { title: latest.title, content: latest.content, scope: latest.scope }
      setEditor({ original: latest, input, baseline: JSON.stringify(input), epoch: memory.status!.epoch })
      setSelected(latest)
      setLatestEntry(undefined)
      setLocalError('')
    })
  }
  async function saveEntry() {
    if (!editor || !memory.writable) return
    const input = { ...editor.input, title: editor.input.title.trim(), content: editor.input.content.trim() }
    if (!input.title || !input.content || input.title.length > 80 || input.content.length > 2000) {
      setLocalError('标题须为 1–80 字符，内容须为 1–2000 字符。')
      return
    }
    const entry = await memory.save(input, editor.original, editor.epoch)
    if (entry) {
      setSelected(entry)
      setEditor(undefined)
      setLocalError('')
    }
  }
  async function showSource(source: MemorySource) {
    const request = ++sourceRequest.current
    setSourceView({ source })
    try {
      if (!connected) throw new Error('服务未连接，无法读取原始条目。')
      const message = await host.sessions.message(source.session, { entryId: source.entryId })
      if (sourceRequest.current === request) setSourceView({ source, message })
    } catch (cause) {
      if (sourceRequest.current === request) setSourceView({ source, error: `来源不可用：${String(cause)}` })
    }
  }
  async function confirmMutation() {
    if (!confirmation || !memory.writable) return
    const accepted =
      confirmation.kind === 'remove'
        ? await memory.remove(confirmation.entry)
        : await memory.clear(confirmation.revision)
    if (accepted) {
      setConfirmation(undefined)
      setSelected(undefined)
      resetDraft()
    }
  }

  if (memory.support === 'unsupported')
    return (
      <p role="status" className="text-muted-foreground">
        当前服务不支持记忆，请升级 Host。
      </p>
    )

  return (
    <div className="@container/memory min-w-0 space-y-6" aria-label="记忆设置">
      <SettingsCard>
        <SettingsRow>
          <div className="min-w-0 space-y-1">
            <h3 className="font-medium">启用记忆</h3>
            <p className="text-muted-foreground">用于后续对话。关闭后保留已存内容。</p>
          </div>
          <Switch
            label="启用记忆"
            checked={config?.enabled ?? false}
            disabled={!memory.writable}
            onChange={(enabled) => void memory.configure({ enabled })}
          />
        </SettingsRow>
        <SettingsRow>
          <div className="min-w-0 space-y-1">
            <h3 className="font-medium">自动学习</h3>
            <p className="text-muted-foreground">从新对话提炼项目记忆，会使用模型额度。</p>
          </div>
          <Switch
            label="自动学习"
            checked={config?.autoLearn ?? false}
            disabled={!memory.writable || !config?.enabled}
            onChange={(autoLearn) => void memory.configure({ autoLearn })}
          />
        </SettingsRow>
        <SettingsRow>
          <span className="min-w-0 truncate text-muted-foreground">
            {!config
              ? '读取中…'
              : config.model
                ? `${config.model.provider} / ${selectedModel?.name ?? config.model.id}`
                : '模型：跟随来源会话'}
          </span>
          <Button
            variant="ghost"
            className={settingsControlClassName}
            aria-expanded={advanced}
            aria-controls="memory-learning-settings"
            onClick={() => setAdvanced((value) => !value)}
          >
            学习设置{advanced ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </Button>
        </SettingsRow>
        {advanced && (
          <div id="memory-learning-settings" className="space-y-4 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label id="memory-model-label">提炼模型</label>
              <Select
                value={config ? (config.model ? modelKey(config.model) : 'inherit') : ''}
                disabled={!memory.writable}
                onValueChange={(value) => {
                  const model = models.find((entry) => modelKey(entry) === value)
                  if (value === 'inherit') void memory.configure({ model: null })
                  else if (model) void memory.configure({ model: { provider: model.provider, id: model.id } })
                }}
              >
                <SelectTrigger
                  aria-labelledby="memory-model-label"
                  className={cn(settingsControlClassName, 'w-full @sm/memory:w-64')}
                >
                  <SelectValue placeholder="读取中…" />
                </SelectTrigger>
                <SelectContent side="bottom">
                  <SelectItem value="inherit">跟随来源会话</SelectItem>
                  {modelUnavailable && config?.model && (
                    <SelectItem value={modelKey(config.model)} disabled>
                      {config.model.provider} / {config.model.id}（当前不可用）
                    </SelectItem>
                  )}
                  {models.map((model) => (
                    <SelectItem key={modelKey(model)} value={modelKey(model)}>
                      {model.provider} / {model.name ?? model.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(modelUnavailable || !models.length) && (
              <div className="text-muted-foreground">
                {modelUnavailable ? '已保存的模型当前不可用。' : '暂无可用模型。'}
                <Button variant="link" size="sm" className={settingsControlClassName} onClick={onModels}>
                  前往模型设置
                </Button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <label htmlFor="memory-budget" className="flex-1">
                每日学习预算（Token）
              </label>
              <Input
                id="memory-budget"
                type="number"
                min={20000}
                max={1000000}
                step={10000}
                value={budgetValue}
                disabled={!config || saving}
                onChange={(event) => setBudgetDraft(event.target.value)}
                className="h-8 w-32 text-xs"
                aria-invalid={dirtyBudget && !budgetValid}
              />
              {dirtyBudget && (
                <Button
                  size="sm"
                  className={settingsControlClassName}
                  disabled={!memory.writable || !budgetValid}
                  onClick={async () => {
                    if (await memory.configure({ dailyTokenBudget: Number(budgetValue) })) setBudgetDraft(undefined)
                  }}
                >
                  保存预算
                </Button>
              )}
            </div>
            {dirtyBudget && !budgetValid && (
              <p role="alert" className="text-destructive">
                预算须为 20000–1000000 之间的整数。
              </p>
            )}
            <p className="text-muted-foreground">
              只从普通、完全权限根会话的新内容学习；预算为调度估算，不是金额上限。
            </p>
            {budget && (
              <p className="tabular-nums text-muted-foreground">
                {budget.date}：已知 {budget.tokens.toLocaleString()} Token，预留 {budget.reserved.toLocaleString()}，
                {budget.calls} 次调用{budget.unknownCalls ? `，${budget.unknownCalls} 次用量未知` : ''}
              </p>
            )}
          </div>
        )}
      </SettingsCard>

      <div className="space-y-2" role="status" aria-live="polite">
        {!connected ? (
          <p className="text-destructive">服务未连接，显示上次确认的内容。恢复连接前无法保存。</p>
        ) : !config ? (
          <p className="text-muted-foreground">正在读取记忆…</p>
        ) : !config.enabled ? (
          <p className="text-muted-foreground">已关闭。已进入会话的内容仍保留，已存记忆可继续管理。</p>
        ) : !config.autoLearn ? (
          <p className="text-muted-foreground">自动学习已暂停，仍会使用已有记忆。</p>
        ) : (
          <p className="text-muted-foreground">
            {activeJob
              ? jobLabels[activeJob.state]
              : failedJob
                ? `最近任务：${jobLabels[failedJob.state]}`
                : '等待新的可学习对话'}
          </p>
        )}
        {memory.notice && <p>{memory.notice}</p>}
      </div>
      {(memory.error || memory.status?.error || memory.writeError || localError) && (
        <div className="space-y-2 rounded-lg border border-destructive/30 p-3" role="alert">
          {[memory.error, memory.status?.error, memory.writeError, localError].filter(Boolean).map((message, index) => (
            <p key={index} className="break-words text-destructive">
              {message}
            </p>
          ))}
          {memory.writeError && dirty && (
            <p className="text-muted-foreground">草稿已保留。若内容发生冲突，请先读取最新数据再决定如何保存。</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!connected || memory.reading}
              onClick={() => void reloadLatest()}
            >
              重新读取
            </Button>
            {memory.failedConfig && (
              <Button
                variant="outline"
                size="sm"
                disabled={!memory.writable}
                onClick={() => void memory.configure(memory.failedConfig!)}
              >
                重试设置
              </Button>
            )}
          </div>
        </div>
      )}

      {jobs.length > 0 && (
        <SettingsGroup
          title="学习任务"
          action={
            <Button variant="ghost" size="sm" aria-expanded={showJobs} onClick={() => setShowJobs((value) => !value)}>
              {showJobs ? '收起' : '查看近期任务'}
            </Button>
          }
        >
          {(showJobs || activeJob) && (
            <div className="divide-y divide-border/60 rounded-lg border border-border/70">
              {(showJobs ? jobs : activeJob ? [activeJob] : []).map((job) => (
                <div key={job.id} className="space-y-1 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {projectName(job.projectId)} · {jobLabels[job.state]}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums text-muted-foreground">
                        {job.unknownUsage
                          ? `已知 ${job.tokens.toLocaleString()} Token · 部分未知`
                          : `${job.tokens.toLocaleString()} Token`}
                      </span>
                      {runningJob(job) && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!memory.writable}
                          onClick={() => void memory.controlJob('stop', job.id)}
                        >
                          停止
                        </Button>
                      )}
                      {['failed', 'interrupted', 'cancelled', 'budget-paused'].includes(job.state) && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!memory.writable || !config?.enabled || !config.autoLearn}
                          onClick={() => void memory.controlJob('retry', job.id)}
                        >
                          重试
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="text-muted-foreground">{readableDate(job.updatedAt)}</p>
                  {job.error && <p className="break-words text-destructive">{job.error}</p>}
                </div>
              ))}
            </div>
          )}
        </SettingsGroup>
      )}

      <section aria-label="记忆管理" className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            aria-label="搜索记忆"
            placeholder="搜索记忆"
            value={memory.query}
            onChange={(event) => memory.search(event.target.value)}
            className="h-9 min-w-36 flex-1 text-xs"
          />
          <Select
            value={memory.filter}
            onValueChange={(value) =>
              leave(() => {
                resetDraft()
                setSelected(undefined)
                memory.selectFilter(value)
              })
            }
          >
            <SelectTrigger aria-label="记忆范围" className="h-9 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="bottom">
              <SelectItem value="all">全部范围</SelectItem>
              <SelectItem value="global">通用</SelectItem>
              {memory.projects.map((project) => (
                <SelectItem key={project.projectId} value={`project:${project.projectId}`}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button ref={createButton} className="h-9" size="sm" disabled={!memory.writable} onClick={beginCreate}>
            <Plus className="size-3.5" />
            添加记忆
          </Button>
          <TooltipHint content="重新读取记忆">
            <Button
              variant="ghost"
              size="icon"
              aria-label="刷新记忆"
              disabled={!connected || memory.reading}
              onClick={() => void memory.reload()}
            >
              <RefreshCw className={cn('size-3.5', memory.reading && 'animate-spin motion-reduce:animate-none')} />
            </Button>
          </TooltipHint>
        </div>
        <div
          className={cn(
            'grid min-w-0 items-start gap-6',
            hasDetail && '@[42rem]/memory:grid-cols-[minmax(0,0.38fr)_minmax(0,0.62fr)]',
          )}
        >
          <div className={cn('min-w-0 space-y-3', hasDetail && 'hidden @[42rem]/memory:block')}>
            <div
              className="max-h-[min(36rem,65vh)] overflow-y-auto overscroll-contain rounded-xl border border-border/70"
              aria-busy={memory.reading}
            >
              {!memory.page ? (
                <p role="status" className="px-4 py-6 text-muted-foreground">
                  {memory.error ? '记忆尚未读取，请重试。' : '读取中…'}
                </p>
              ) : !memory.page.entries.length ? (
                <p role="status" className="px-4 py-6 text-muted-foreground">
                  {memory.query
                    ? '没有匹配的记忆'
                    : memory.status?.totalEntries
                      ? '此范围还没有记忆'
                      : '还没有记忆。可以手动添加，或开启后从新对话学习。'}
                </p>
              ) : (
                <div className="divide-y divide-border/60">
                  {memory.page.entries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      aria-pressed={selected?.id === entry.id || editor?.original?.id === entry.id}
                      onClick={(event) => selectEntry(entry, event.currentTarget)}
                      className={cn(
                        'block w-full min-w-0 space-y-1 px-4 py-3 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                        (selected?.id === entry.id || editor?.original?.id === entry.id) && 'bg-foreground/7',
                      )}
                    >
                      <span className="flex min-w-0 items-start justify-between gap-3">
                        <span className="line-clamp-2 min-w-0 font-medium [overflow-wrap:anywhere]">{entry.title}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {entry.scope.kind === 'global' ? '通用' : '项目'}
                        </span>
                      </span>
                      <span className="block truncate text-muted-foreground">{entry.content}</span>
                      <span className="block truncate text-muted-foreground">
                        {scopeName(entry)} · {entry.locked ? '手动保存' : '自动学习'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {(memory.pageIndex > 0 || memory.page?.nextCursor) && (
              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!memory.pageIndex || memory.reading}
                  onClick={memory.previousPage}
                >
                  上一页
                </Button>
                <span className="tabular-nums text-muted-foreground">第 {memory.pageIndex + 1} 页</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!memory.page?.nextCursor || memory.reading}
                  onClick={memory.nextPage}
                >
                  下一页
                </Button>
              </div>
            )}
          </div>
          {hasDetail && (
            <div className="min-w-0 space-y-4 @[42rem]/memory:border-l @[42rem]/memory:border-border/60 @[42rem]/memory:pl-6">
              <Button
                variant="ghost"
                size="sm"
                className="@[42rem]/memory:hidden"
                disabled={saving}
                onClick={closeDetail}
              >
                <ArrowLeft className="size-3.5" />
                返回列表
              </Button>
              {editor ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium">{editor.original ? '编辑记忆' : '添加记忆'}</h3>
                    <TooltipHint content="关闭编辑">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="关闭记忆编辑"
                        className="hidden @[42rem]/memory:inline-flex"
                        disabled={saving}
                        onClick={closeDetail}
                      >
                        <X />
                      </Button>
                    </TooltipHint>
                  </div>
                  <label className="grid gap-2">
                    标题
                    <Input
                      maxLength={80}
                      value={editor.input.title}
                      onChange={(event) =>
                        setEditor({ ...editor, input: { ...editor.input, title: event.target.value } })
                      }
                    />
                    <span className="text-right tabular-nums text-muted-foreground">
                      {editor.input.title.length}/80
                    </span>
                  </label>
                  <label className="grid gap-2">
                    内容
                    <Textarea
                      maxLength={2000}
                      value={editor.input.content}
                      onChange={(event) =>
                        setEditor({ ...editor, input: { ...editor.input, content: event.target.value } })
                      }
                      className="min-h-36 text-xs"
                    />
                    <span className="text-right tabular-nums text-muted-foreground">
                      {editor.input.content.length}/2000
                    </span>
                  </label>
                  <div className="flex min-w-0 flex-col gap-2">
                    <span id="memory-editor-scope-label" className="font-medium leading-snug">
                      范围
                    </span>
                    <Select
                      value={memoryScopeKey(editor.input.scope)}
                      onValueChange={(value) => {
                        const scope = parseMemoryScope(value)
                        if (scope) setEditor({ ...editor, input: { ...editor.input, scope } })
                      }}
                    >
                      <SelectTrigger aria-labelledby="memory-editor-scope-label" className="text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent side="bottom">
                        <SelectItem value="global">通用 · 当前 Host 的所有项目</SelectItem>
                        {editor.input.scope.kind === 'project' &&
                          !memory.projects.some(
                            (project) =>
                              project.projectId ===
                              (editor.input.scope.kind === 'project' ? editor.input.scope.projectId : ''),
                          ) && (
                            <SelectItem value={memoryScopeKey(editor.input.scope)} disabled>
                              原项目（未在当前列表中）
                            </SelectItem>
                          )}
                        {memory.projects.map((project) => (
                          <SelectItem key={project.projectId} value={`project:${project.projectId}`}>
                            {project.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-muted-foreground">手动保存后，自动学习不会覆盖这条记忆。</p>
                  {latestEntry && (
                    <div className="space-y-2 rounded-lg border border-border p-3">
                      <h4 className="font-medium">Host 上的最新内容</h4>
                      <p className="break-words font-medium">{latestEntry.title}</p>
                      <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">
                        {latestEntry.content}
                      </p>
                      <Button variant="outline" size="sm" disabled={saving} onClick={adoptLatest}>
                        载入最新内容
                      </Button>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={!memory.writable || !editor.input.title.trim() || !editor.input.content.trim()}
                      onClick={() => void saveEntry()}
                    >
                      {memory.busy === 'entry' && (
                        <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
                      )}
                      保存
                    </Button>
                    <Button variant="outline" size="sm" disabled={saving} onClick={() => leave(resetDraft)}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                selected && (
                  <MemoryEntryPreview
                    entry={selected}
                    scopeLabel={scopeName(selected)}
                    writable={memory.writable}
                    connected={connected}
                    onEdit={beginEdit}
                    onDelete={() => setConfirmation({ kind: 'remove', entry: selected })}
                    onClose={closeDetail}
                    onShowSource={(source) => void showSource(source)}
                  />
                )
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3 text-muted-foreground">
          <span>
            {memory.status ? `${memory.status.totalEntries} 条记忆` : '记忆数量未知'} · {hostLabel}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={!memory.writable || !memory.status?.totalEntries}
            onClick={() =>
              leave(() => {
                if (memory.status)
                  setConfirmation({
                    kind: 'clear',
                    revision: memory.status.revision,
                    count: memory.status.totalEntries,
                  })
              })
            }
          >
            清空全部记忆
          </Button>
        </div>
      </section>

      <Dialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open && !saving) setConfirmation(undefined)
        }}
      >
        <DialogContent>
          <DialogTitle>{confirmation?.kind === 'clear' ? '清空当前 Host 的全部记忆？' : '删除这条记忆？'}</DialogTitle>
          <DialogDescription>
            {confirmation?.kind === 'clear'
              ? `${hostLabel} 的 ${confirmation.count} 条通用与所有项目记忆将被删除。保留聊天和用量记录，不从已有消息重新学习。`
              : '保留聊天记录，关联的旧消息不再参与自动学习。已进入会话的内容仍保留。'}
          </DialogDescription>
          {memory.writeError && (
            <div role="alert" className="space-y-1 text-sm text-destructive">
              <p>{memory.writeError}</p>
              <p>若内容已经变化，请取消后重新读取并确认。</p>
            </div>
          )}
          {!connected && (
            <p role="status" className="text-sm text-destructive">
              服务未连接，无法提交。
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={saving} onClick={() => setConfirmation(undefined)}>
              取消
            </Button>
            <Button disabled={!memory.writable} onClick={() => void confirmMutation()}>
              {saving ? '正在提交…' : confirmation?.kind === 'clear' ? '清空全部' : '删除'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(pendingLeave)}
        onOpenChange={(open) => {
          if (!open) setPendingLeave(null)
        }}
      >
        <DialogContent>
          <DialogTitle>丢弃未保存的记忆修改？</DialogTitle>
          <DialogDescription>当前草稿尚未保存到 Host，离开后不会保留。</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPendingLeave(null)}>
              继续编辑
            </Button>
            <Button
              onClick={() => {
                resetDraft()
                const action = pendingLeave
                setPendingLeave(null)
                action?.()
              }}
            >
              丢弃修改
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(sourceView)}
        onOpenChange={(open) => {
          if (!open) {
            sourceRequest.current++
            setSourceView(undefined)
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogTitle>记忆来源</DialogTitle>
          <DialogDescription className="break-all">原始条目 {sourceView?.source.entryId}</DialogDescription>
          <div className="max-h-[55vh] overflow-y-auto text-sm">
            {sourceView?.error ? (
              <p role="alert" className="text-destructive">
                {sourceView.error}
              </p>
            ) : sourceView?.message ? (
              renderSource(sourceView.message)
            ) : (
              <p role="status" className="text-muted-foreground">
                正在读取原始条目…
              </p>
            )}
          </div>
          {sourceView?.message && (
            <div className="flex justify-end">
              <Button
                variant="outline"
                disabled={!connected || openingSession}
                onClick={async () => {
                  if (!sourceView) return
                  setOpeningSession(true)
                  try {
                    await onOpenSourceSession(sourceView.source)
                  } catch (cause) {
                    setSourceView({ ...sourceView, error: String(cause) })
                  } finally {
                    setOpeningSession(false)
                  }
                }}
              >
                打开来源会话
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
