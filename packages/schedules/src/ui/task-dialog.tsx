import { useId, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Clock, Loader2 } from 'lucide-react'
import type { AppProject } from '@pi-meme/contracts/app-host'
import type {
  ScheduleConfiguration,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduleRule,
} from '@pi-meme/contracts/schedules'
import { agentAccessChoices } from '@pi-meme/contracts/agent-access'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import { cn } from '@pi-meme/ui/lib/utils'
import { formatScheduleTime, localTimeToInstant, nextOccurrence } from '../shared/rules'

export type ScheduleModelPicker = (
  configuration: ScheduleConfiguration,
  onChange: (configuration: ScheduleConfiguration) => void,
) => ReactNode
const frequencies = { once: '单次', daily: '每天', weekdays: '工作日', weekly: '每周', interval: '固定间隔' } as const
const selectClass =
  'h-9 w-auto min-w-28 justify-end gap-2 border-0 bg-transparent px-2 text-sm text-muted-foreground shadow-none hover:bg-secondary/70 focus-visible:ring-1'

function Choice({
  value,
  onChange,
  label,
  choices,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  choices: Array<{ value: string; label: string }>
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className={selectClass}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" position="popper" side="bottom">
        {choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-4 px-5 py-2">
      <span className="shrink-0 text-sm font-medium">{label}</span>
      <div className="flex min-w-0 items-center justify-end gap-2">{children}</div>
    </div>
  )
}

export function TaskDialog({
  task,
  template,
  projects,
  defaults,
  locationLabel,
  plugins,
  renderModelPicker,
  renderAccessSelector,
  onClose,
  onSave,
}: {
  task?: ScheduledTask
  template?: { name: string; prompt: string; weekly?: boolean }
  projects: AppProject[]
  defaults: ScheduleConfiguration
  locationLabel: string
  plugins: Array<{ id: string; name: string }>
  renderModelPicker: ScheduleModelPicker
  renderAccessSelector: ScheduleModelPicker
  onClose: () => void
  onSave: (input: ScheduledTaskInput) => Promise<void>
}) {
  const initialRule = task?.rule
  const [name, setName] = useState(task?.name ?? template?.name ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? template?.prompt ?? '')
  const [kind, setKind] = useState<ScheduleRule['kind']>(initialRule?.kind ?? (template?.weekly ? 'weekly' : 'daily'))
  const [time, setTime] = useState(initialRule && 'time' in initialRule ? initialRule.time : '09:00')
  const [timeZone, setTimeZone] = useState(
    initialRule?.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone,
  )
  const [date, setDate] = useState(() => {
    if (initialRule?.kind === 'once') {
      const value = new Intl.DateTimeFormat('en-CA', {
        timeZone: initialRule.timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(initialRule.at))
      return value
    }
    const tomorrow = new Date(Date.now() + 86400000)
    return `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
  })
  const [onceTime, setOnceTime] = useState(() =>
    initialRule?.kind === 'once'
      ? new Intl.DateTimeFormat('en-GB', {
          timeZone: initialRule.timeZone,
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(new Date(initialRule.at))
      : '09:00',
  )
  const [weekdays, setWeekdays] = useState(
    initialRule && 'weekdays' in initialRule ? (initialRule.weekdays ?? [1]) : [1],
  )
  const [every, setEvery] = useState(String(initialRule?.kind === 'interval' ? initialRule.every : 1))
  const [unit, setUnit] = useState<'minutes' | 'hours'>(initialRule?.kind === 'interval' ? initialRule.unit : 'hours')
  const anchor = initialRule?.kind === 'interval' ? initialRule.anchor : undefined
  const [projectId, setProjectId] = useState(task?.project?.projectId ?? 'none')
  const advancedId = useId()
  const [advanced, setAdvanced] = useState(false)
  const [newSessionEachRun, setNewSessionEachRun] = useState(task?.newSessionEachRun ?? true)
  const [configuration, setConfiguration] = useState(task?.configuration ?? defaults)
  const [notification, setNotification] = useState(task?.notification ?? 'all')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  function rule(): ScheduleRule {
    if (kind === 'once') {
      const at = localTimeToInstant(date, onceTime, timeZone)
      if (!at) throw new Error('所选时间在该时区不存在，请更换时间')
      return { kind, at, timeZone }
    }
    if (kind === 'interval')
      return { kind, every: Number(every), unit, anchor: anchor ?? new Date().toISOString(), timeZone }
    return { kind, time, timeZone, ...(kind === 'weekly' ? { weekdays } : {}) }
  }
  let next: string | undefined
  let previewError = ''
  const unchangedRule = task && JSON.stringify(ruleForComparison()) === JSON.stringify(task.rule)
  function ruleForComparison() {
    try {
      return rule()
    } catch {
      return undefined
    }
  }
  try {
    next = nextOccurrence(rule(), Date.now())
    if (!next && !unchangedRule) previewError = '请选择未来的执行时间'
  } catch (cause) {
    previewError = cause instanceof Error ? cause.message : String(cause)
  }
  const valid = Boolean(
    name.trim() && prompt.trim() && configuration.model.id && (next || unchangedRule) && !previewError,
  )
  async function save() {
    if (!valid || saving) return
    setSaving(true)
    setError('')
    try {
      const project = projects.find((item) => item.projectId === projectId)
      await onSave({
        name: name.trim(),
        prompt: prompt.trim(),
        project: task?.project ?? (project ? { hostId: project.hostId, projectId: project.projectId } : undefined),
        rule: rule(),
        newSessionEachRun,
        configuration,
        notification,
      })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent
        className="flex w-[calc(100vw-2rem)] max-w-[680px] flex-col gap-0 rounded-[28px] border-border/60 bg-card p-0 shadow-2xl sm:rounded-[32px]"
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (saving) event.preventDefault()
        }}
      >
        <div className="shrink-0 px-7 pb-5 pt-7 sm:px-8">
          <DialogTitle className="text-xl tracking-normal">{task ? '编辑定时任务' : '设置定时任务'}</DialogTitle>
          <DialogDescription className="sr-only">填写任务说明和执行时间，由所选 Host 按安排运行。</DialogDescription>
        </div>
        <form
          className="min-h-0 overflow-y-auto px-7 sm:px-8"
          id="schedule-task-form"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <fieldset disabled={saving} className="@container space-y-4 pb-1 disabled:opacity-70">
            <Input
              aria-label="任务名称"
              placeholder="任务名称"
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-11 rounded-xl border-border/70 bg-transparent px-4 shadow-none"
              autoFocus
            />
            <textarea
              aria-label="执行说明"
              placeholder="说明任务需要做什么…"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              className="min-h-32 w-full resize-y rounded-[20px] border border-border/70 bg-transparent px-5 py-4 text-sm leading-7 outline-none placeholder:text-muted-foreground/65 focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="overflow-hidden rounded-[20px] border border-border/70">
              <Row label="重复">
                <Choice
                  label="运行频率"
                  value={kind}
                  onChange={(value) => setKind(value as ScheduleRule['kind'])}
                  choices={Object.entries(frequencies).map(([value, label]) => ({ value, label }))}
                />
              </Row>
              <div className="mx-4 border-t border-border/60" />
              {kind === 'interval' ? (
                <Row label="间隔">
                  <Input
                    aria-label="间隔数值"
                    type="number"
                    min="1"
                    max="525600"
                    value={every}
                    onChange={(event) => setEvery(event.target.value)}
                    className="h-9 w-20 border-0 bg-secondary/50 text-right shadow-none"
                  />
                  <Choice
                    label="间隔单位"
                    value={unit}
                    onChange={(value) => setUnit(value as typeof unit)}
                    choices={[
                      { value: 'minutes', label: '分钟' },
                      { value: 'hours', label: '小时' },
                    ]}
                  />
                </Row>
              ) : (
                <Row label="时间">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {kind === 'once' && (
                      <input
                        aria-label="执行日期"
                        type="date"
                        value={date}
                        onChange={(event) => setDate(event.target.value)}
                        className="max-w-36 rounded-md border-0 bg-transparent px-1 text-sm text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring [color-scheme:light_dark]"
                      />
                    )}
                    <span className="text-sm text-muted-foreground">
                      {timeZone === 'Asia/Shanghai' ? '中国时间' : timeZone.split('/').at(-1)?.replaceAll('_', ' ')}
                    </span>
                    <input
                      aria-label="执行时间"
                      type="time"
                      step="60"
                      value={kind === 'once' ? onceTime : time}
                      onChange={(event) =>
                        kind === 'once' ? setOnceTime(event.target.value) : setTime(event.target.value)
                      }
                      className="w-[68px] rounded-md border-0 bg-transparent px-1 py-1.5 text-sm text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-calendar-picker-indicator]:hidden"
                    />
                    <TimePresets
                      value={kind === 'once' ? onceTime : time}
                      onChange={(value) => (kind === 'once' ? setOnceTime(value) : setTime(value))}
                    />
                  </div>
                </Row>
              )}
              {kind === 'weekly' && (
                <div className="flex justify-end gap-1.5 px-5 pb-4" aria-label="执行星期">
                  {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                    <button
                      type="button"
                      key={day}
                      aria-label={`星期${'日一二三四五六'[day]}`}
                      aria-pressed={weekdays.includes(day)}
                      onClick={() =>
                        setWeekdays((values) =>
                          values.includes(day) ? values.filter((value) => value !== day) : [...values, day],
                        )
                      }
                      className={cn(
                        'flex size-8 items-center justify-center rounded-full text-xs transition-colors',
                        weekdays.includes(day)
                          ? 'bg-foreground text-background'
                          : 'bg-secondary text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {'日一二三四五六'[day]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              aria-expanded={advanced}
              aria-controls={advancedId}
              onClick={() => setAdvanced((value) => !value)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              高级
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  'size-3.5 transition-transform duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                  advanced && 'rotate-180',
                )}
              />
            </button>
            <div
              id={advancedId}
              aria-hidden={!advanced}
              inert={!advanced}
              className={cn(
                '!my-0 grid transition-[grid-template-rows,opacity] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                advanced ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="space-y-3 pb-4">
                  <div className="overflow-hidden rounded-[20px] border border-border/70">
                    <Row label="执行位置">
                      <span className="truncate px-2 text-sm text-muted-foreground" title={locationLabel}>
                        {locationLabel}
                      </span>
                    </Row>
                    <div className="mx-4 border-t border-border/60" />
                    <Row label="项目">
                      {task ? (
                        <span className="truncate px-2 text-sm text-muted-foreground">
                          {projects.find((item) => item.projectId === task.project?.projectId)?.name ??
                            (task.project ? '项目不可用' : '独立工作目录')}
                        </span>
                      ) : (
                        <Choice
                          label="执行项目"
                          value={projectId}
                          onChange={setProjectId}
                          choices={[
                            { value: 'none', label: '独立工作目录' },
                            ...projects
                              .filter((project) => !project.unavailable)
                              .map((project) => ({ value: project.projectId, label: project.name })),
                          ]}
                        />
                      )}
                    </Row>
                  </div>
                  <div className="rounded-[20px] border border-border/70">
                    <Row label="时区">
                      <input
                        aria-label="时区"
                        list="schedule-time-zones"
                        value={timeZone}
                        onChange={(event) => setTimeZone(event.target.value)}
                        className="h-9 w-44 rounded-md border-0 bg-transparent px-2 text-right text-sm text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                      <datalist id="schedule-time-zones">
                        {[
                          'Asia/Shanghai',
                          'Asia/Tokyo',
                          'Asia/Singapore',
                          'Europe/London',
                          'Europe/Berlin',
                          'America/New_York',
                          'America/Los_Angeles',
                          'UTC',
                        ].map((zone) => (
                          <option key={zone} value={zone} />
                        ))}
                      </datalist>
                    </Row>
                  </div>
                  <div className="rounded-[20px] border border-border/70">
                    <Row label="每次运行时都开启新聊天">
                      <Switch
                        label="每次运行时都开启新聊天"
                        checked={newSessionEachRun}
                        onChange={setNewSessionEachRun}
                      />
                    </Row>
                  </div>
                  <div className="rounded-[20px] border border-border/70">
                    <Row label="通知">
                      <Choice
                        label="通知方式"
                        value={notification}
                        onChange={(value) => setNotification(value as typeof notification)}
                        choices={[
                          { value: 'all', label: '每次完成' },
                          { value: 'failures', label: '仅失败' },
                          { value: 'off', label: '关闭' },
                        ]}
                      />
                    </Row>
                  </div>
                  <div className="rounded-[20px] border border-border/70">
                    <Row label="模型与强度">
                      <span className="max-w-36 truncate text-xs text-muted-foreground @min-[500px]:hidden">
                        {configuration.model.name ?? configuration.model.id}
                      </span>
                      {renderModelPicker(configuration, setConfiguration)}
                    </Row>
                  </div>
                  <div className="rounded-[20px] border border-border/70">
                    <Row label="访问权限">
                      <span className="text-xs text-muted-foreground @min-[500px]:hidden">
                        {agentAccessChoices.find((choice) => choice.mode === configuration.accessMode)?.label}
                      </span>
                      {renderAccessSelector(configuration, setConfiguration)}
                    </Row>
                  </div>
                  <div className="rounded-[20px] border border-border/70 px-5 py-4">
                    <span className="text-sm font-medium">Agent 插件</span>
                    <div className="mt-3 space-y-3">
                      {plugins.length ? (
                        plugins.map((plugin) => (
                          <label
                            key={plugin.id}
                            className="flex items-center justify-between gap-3 text-sm text-muted-foreground"
                          >
                            <span className="truncate">{plugin.name}</span>
                            <Switch
                              label={`启用插件：${plugin.name}`}
                              checked={configuration.agentPlugins.includes(plugin.id)}
                              onChange={(checked) =>
                                setConfiguration({
                                  ...configuration,
                                  agentPlugins: checked
                                    ? [...configuration.agentPlugins, plugin.id]
                                    : configuration.agentPlugins.filter((id) => id !== plugin.id),
                                })
                              }
                            />
                          </label>
                        ))
                      ) : (
                        <p className="text-xs text-muted-foreground">没有可用的 Agent 插件</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <p className="flex items-start gap-2 px-1 text-xs leading-5 text-muted-foreground">
              <Clock className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {previewError ||
                  (next ? `下次运行：${formatScheduleTime(next, timeZone)} · ${timeZone}` : '暂无后续安排')}
                <br />
                执行 Host 需要保持运行；休眠或离线期间错过的任务将跳过。
              </span>
            </p>
            {!configuration.model.id && (
              <p role="alert" className="text-sm text-destructive">
                请先在模型设置中配置可用模型。
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </fieldset>
        </form>
        <div className="flex shrink-0 justify-end gap-3 px-7 pb-6 pt-5 sm:px-8">
          <Button
            type="button"
            variant="secondary"
            disabled={saving}
            onClick={onClose}
            className="h-10 rounded-full px-6"
          >
            取消
          </Button>
          <Button
            type="submit"
            form="schedule-task-form"
            disabled={!valid || saving}
            className="h-10 rounded-full px-6"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {task ? '保存' : '创建'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TimePresets({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="快捷选择时间"
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary"
        >
          <ChevronDown className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-40 rounded-2xl p-1.5">
        <div className="max-h-60 overflow-y-auto">
          {Array.from({ length: 96 }, (_, index) => {
            const time = `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`
            return (
              <button
                type="button"
                key={time}
                aria-pressed={value === time}
                ref={(element) => {
                  if (element && open && value === time) element.scrollIntoView({ block: 'center' })
                }}
                onClick={() => {
                  onChange(time)
                  setOpen(false)
                }}
                className={cn(
                  'flex h-9 w-full items-center justify-between rounded-lg px-3 text-sm hover:bg-secondary',
                  value === time && 'bg-secondary',
                )}
              >
                {time}
                {value === time && <Check aria-hidden="true" className="size-4" />}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
