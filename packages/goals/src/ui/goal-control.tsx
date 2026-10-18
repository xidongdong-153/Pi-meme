import { useEffect, useState } from 'react'
import { CirclePause, CirclePlay, Maximize, Target, Trash2, X } from 'lucide-react'
import type { Goal, GoalEdit } from '@pi-meme/contracts/goal'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Textarea } from '@pi-meme/ui/components/ui/textarea'

const labels: Record<Goal['status'], string> = {
  active: '执行中',
  paused: '已暂停',
  blocked: '受阻',
  usage_limited: '用量受限',
  complete: '已完成',
}
function tokens(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}
function GoalTime({ elapsedMs, running }: { elapsedMs: number; running: boolean }) {
  const [started] = useState(Date.now)
  const [now, setNow] = useState(started)
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  const value = elapsedMs + (running ? Math.max(0, now - started) : 0)
  return <>{value < 60000 ? `${Math.floor(value / 1000)} 秒` : `${Math.floor(value / 60000)} 分钟`}</>
}

type Props = {
  goal?: Goal
  draft?: true
  onDraft: (draft: true | undefined) => void
  open: boolean
  onOpen: (open: boolean) => void
  editing: boolean
  running: boolean
  onAction: (action: 'pause' | 'resume' | 'edit' | 'clear') => Promise<void>
  onSave: (input: GoalEdit) => Promise<void>
  onError: (message: string) => void
}

export function GoalControl({
  goal,
  draft,
  onDraft,
  open,
  onOpen,
  editing,
  running,
  onAction,
  onSave,
  onError,
}: Props) {
  const [pending, setPending] = useState<string>()
  if (draft)
    return (
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="取消创建目标"
            onClick={() => {
              onDraft(undefined)
              onOpen(false)
            }}
            className="group inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-secondary p-1.5 @min-[500px]:px-2 text-xs text-foreground transition-colors hover:bg-secondary/70 cursor-pointer select-none"
          >
            <Target className="size-4 group-hover:hidden group-focus-visible:hidden" />
            <span className="hidden size-4 items-center justify-center rounded-full bg-muted-foreground/20 group-hover:flex group-focus-visible:flex">
              <X className="size-3" />
            </span>
            <span className="hidden @min-[500px]:inline">目标</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">取消创建目标</TooltipContent>
      </Tooltip>
    )
  if (!goal) return null
  const apply = async (name: string, action: () => Promise<void>) => {
    if (pending) return
    setPending(name)
    try {
      await action()
    } catch (cause) {
      onError(String(cause))
    } finally {
      setPending(undefined)
    }
  }
  const edit = () =>
    apply('edit', async () => {
      await onAction('edit')
    })
  return (
    <Popover open={open} onOpenChange={onOpen}>
      <div className="@container relative mx-3 -mb-3 flex min-w-0 items-center gap-1 rounded-t-2xl border border-border/70 bg-secondary/70 px-3 pb-4 pt-2">
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="目标详情"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Target className="size-4 shrink-0 text-muted-foreground" />
            <span className="shrink-0 font-medium">{labels[goal.status]}的目标</span>
            <span className="truncate text-muted-foreground">{goal.objective}</span>
            <span className="hidden shrink-0 text-muted-foreground @md:inline">{tokens(goal.tokensUsed)} Token</span>
            <span className="shrink-0 text-muted-foreground">
              ·{' '}
              <GoalTime
                key={`${goal.goalId}:${goal.elapsedMs}:${running}`}
                elapsedMs={goal.elapsedMs}
                running={running && goal.status === 'active'}
              />
            </span>
          </button>
        </PopoverTrigger>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground"
          aria-label="清除目标"
          title="清除目标"
          disabled={!!pending}
          onClick={() => void apply('clear', () => onAction('clear'))}
        >
          <Trash2 className="size-4" />
        </Button>
        {goal.status !== 'complete' ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label={goal.status === 'active' ? '暂停目标' : '恢复目标'}
            title={goal.status === 'active' ? '暂停目标' : '恢复目标'}
            disabled={!!pending || (goal.status !== 'active' && (running || editing))}
            onClick={() =>
              void apply(goal.status === 'active' ? 'pause' : 'resume', () =>
                onAction(goal.status === 'active' ? 'pause' : 'resume'),
              )
            }
          >
            {goal.status === 'active' ? <CirclePause className="size-4" /> : <CirclePlay className="size-4" />}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground"
          aria-label="展开目标"
          title="展开目标"
          onClick={() => onOpen(!open)}
        >
          <Maximize className="size-4" />
        </Button>
      </div>
      <PopoverContent side="top" align="start" className="w-[min(28rem,calc(100vw-2rem))] space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">目标 · {labels[goal.status]}</span>
        </div>
        {editing ? (
          <GoalEditor
            key={`${goal.goalId}:${goal.revision}`}
            goal={goal}
            disabled={!!pending || running}
            onSave={(input) => apply('save', () => onSave(input))}
          />
        ) : (
          <p className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-sm">{goal.objective}</p>
        )}
        <p className="text-xs text-muted-foreground">
          已用 {goal.tokensUsed.toLocaleString()} Token · 累计执行 {Math.floor(goal.elapsedMs / 1000)} 秒
          {goal.usageIncomplete ? ' · 用量统计不完整' : ''}
        </p>
        {goal.progress ? <p className="whitespace-pre-wrap break-words text-xs">最近进展：{goal.progress}</p> : null}
        {goal.reason ? (
          <p role="status" className="break-words text-xs text-muted-foreground">
            {goal.reason}
          </p>
        ) : null}
        {goal.evidence.length ? (
          <ul className="max-h-40 list-disc space-y-1 overflow-auto pl-4 text-xs">
            {goal.evidence.map((evidence, index) => (
              <li key={index}>{evidence}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {goal.status === 'active' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!!pending}
              onClick={() => void apply('pause', () => onAction('pause'))}
            >
              暂停
            </Button>
          ) : goal.status !== 'complete' ? (
            <Button
              size="sm"
              disabled={!!pending || running || editing}
              onClick={() => void apply('resume', () => onAction('resume'))}
            >
              恢复
            </Button>
          ) : null}
          {goal.status !== 'complete' && !editing ? (
            <Button size="sm" variant="outline" disabled={!!pending} onClick={() => void edit()}>
              编辑
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={!!pending}
            onClick={() => void apply('clear', () => onAction('clear'))}
          >
            清除目标
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function GoalEditor({
  goal,
  disabled,
  onSave,
}: {
  goal: Goal
  disabled: boolean
  onSave: (input: GoalEdit) => Promise<void>
}) {
  const [objective, setObjective] = useState(goal.objective)
  return (
    <>
      <Textarea
        aria-label="目标正文"
        value={objective}
        onChange={(event) => setObjective(event.target.value)}
        className="max-h-72 min-h-28"
      />
      <Button
        disabled={disabled}
        onClick={() =>
          void onSave({
            goalId: goal.goalId,
            revision: goal.revision,
            objective,
          })
        }
      >
        保存目标
      </Button>
    </>
  )
}
