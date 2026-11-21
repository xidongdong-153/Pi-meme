import { useId, useState } from 'react'
import { CheckCircle2, ChevronDown, CircleDashed, CirclePause, ListChecks, LoaderCircle } from 'lucide-react'
import type { TaskProgress, TaskStepStatus } from '@pi-meme/contracts/task-progress'
import { cn } from '@pi-meme/ui/lib/utils'
import { RetainedDisclosure } from './retained-disclosure'

const statusLabels: Record<TaskStepStatus, string> = {
  pending: '待开始',
  in_progress: '进行中',
  completed: '已完成',
  blocked: '受阻',
}
const statusIcons = { pending: CircleDashed, in_progress: LoaderCircle, completed: CheckCircle2, blocked: CirclePause }

export function TaskProgressCard({
  progress,
  live,
  paused,
  interrupted,
  onToggle,
}: {
  progress: TaskProgress
  live: boolean
  paused: boolean
  interrupted: boolean
  onToggle?: () => void
}) {
  const listId = useId()
  const completed = progress.steps.filter((step) => step.status === 'completed').length
  const done = completed === progress.steps.length
  const [disclosure, setDisclosure] = useState({ done, open: !done })
  if (disclosure.done !== done) setDisclosure({ done, open: !done })
  const waiting =
    !progress.steps.some((step) => step.status === 'in_progress') &&
    progress.steps.some((step) => step.status === 'blocked')
  const status = done
    ? '已完成'
    : interrupted
      ? '已中断'
      : paused
        ? '已暂停'
        : waiting
          ? '受阻'
          : live
            ? ''
            : '上次进度'
  const summary = [status, `${completed}/${progress.steps.length}`].filter(Boolean).join(' ')
  return (
    <section className="conversation-block w-full rounded-xl border border-border bg-card/40" aria-label="任务进度">
      <button
        type="button"
        aria-expanded={disclosure.open}
        aria-controls={listId}
        className="flex min-h-10 w-full items-center gap-2 rounded-xl px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          onToggle?.()
          setDisclosure({ done, open: !disclosure.open })
        }}
      >
        <ListChecks aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">任务进度</span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {summary}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3.5 text-muted-foreground transition-transform motion-reduce:transition-none',
            !disclosure.open && '-rotate-90',
          )}
        />
      </button>
      <RetainedDisclosure
        id={listId}
        open={disclosure.open}
        inert={!disclosure.open}
        aria-hidden={!disclosure.open}
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none',
          disclosure.open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <ul className="space-y-1 px-3 pb-3 text-sm">
            {progress.steps.map((step) => {
              const active = step.status === 'in_progress'
              const idle = active && (!live || paused || interrupted)
              const Icon = idle ? CirclePause : statusIcons[step.status]
              return (
                <li key={step.id} className="flex items-start gap-2">
                  <Icon
                    aria-hidden="true"
                    className={cn(
                      'mt-0.5 size-4 shrink-0 text-muted-foreground',
                      active && !idle && 'animate-spin text-primary motion-reduce:animate-none',
                    )}
                  />
                  <div className="min-w-0 break-words">
                    <span className="sr-only">{idle ? '上次进行到' : statusLabels[step.status]}，</span>
                    <span
                      className={cn(active && 'font-medium', step.status === 'completed' && 'text-muted-foreground')}
                    >
                      {step.title}
                    </span>
                    {step.reason && <p className="text-xs text-muted-foreground">{step.reason}</p>}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      </RetainedDisclosure>
    </section>
  )
}
