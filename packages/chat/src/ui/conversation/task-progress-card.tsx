import { memo, useEffect, useId, useState } from 'react'
import { AlertCircle, Check, CheckCircle2, ChevronDown, CirclePause } from 'lucide-react'
import type { TaskProgressPhase, TaskProgressView, TaskStep, TaskStepStatus } from '@pi-meme/contracts/task-progress'
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { cn } from '@pi-meme/ui/lib/utils'
import { RetainedDisclosure } from './retained-disclosure'

const AUTO_COLLAPSE_DELAY_MS = 550

const statusLabels: Record<TaskStepStatus, string> = {
  pending: '待开始',
  in_progress: '进行中',
  completed: '已完成',
  blocked: '受阻',
}

const phaseLabels: Record<TaskProgressPhase, string> = {
  completed: '已完成',
  interrupted: '已中断',
  paused: '已暂停',
  blocked: '受阻',
  historical: '上次进度',
  running: '',
}

function ProgressRing({
  completed,
  total,
  tone,
}: {
  completed: number
  total: number
  tone: 'primary' | 'success' | 'warning' | 'muted'
}) {
  const size = 16
  const strokeWidth = 2
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const ratio = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0
  const dashOffset = circumference * (1 - ratio)
  const strokeClass =
    tone === 'success'
      ? 'stroke-[var(--color-success)]'
      : tone === 'warning'
        ? 'stroke-amber-500'
        : tone === 'muted'
          ? 'stroke-muted-foreground/70'
          : 'stroke-primary'

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className="size-4 shrink-0 -rotate-90"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={strokeWidth}
        className="stroke-border/80"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        className={cn(
          'transition-[stroke-dashoffset,stroke] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          strokeClass,
        )}
      />
    </svg>
  )
}

function StepIndicator({ step, activeWorking }: { step: TaskStep; activeWorking: boolean }) {
  if (step.status === 'completed') {
    return (
      <span
        aria-hidden="true"
        className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--color-success)_16%,transparent)] text-[var(--color-success)]"
      >
        <Check className="size-2.5 stroke-[2.5]" />
      </span>
    )
  }

  if (step.status === 'blocked') {
    return <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
  }

  if (step.status === 'in_progress') {
    if (!activeWorking) {
      return <CirclePause aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
    }
    return (
      <span aria-hidden="true" className="relative mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
        <span className="task-progress-dot-pulse absolute size-3.5 rounded-full bg-primary/28" />
        <span className="relative size-2 rounded-full bg-primary" />
      </span>
    )
  }

  return (
    <span aria-hidden="true" className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
      <span className="size-2 rounded-full border border-muted-foreground/45" />
    </span>
  )
}

function TaskProgressCardContent({ progress, onToggle }: { progress: TaskProgressView; onToggle?: () => void }) {
  const listId = useId()
  const total = progress.steps.length
  const { completed, phase } = progress
  const done = phase === 'completed'
  const canRun = phase === 'running'
  const focusStep = progress.steps.find((step) => step.id === progress.focusStepId)
  const isWorking = focusStep?.status === 'in_progress' && canRun

  const [disclosure, setDisclosure] = useState(() => ({
    done,
    open: !done,
    pendingCollapse: false,
  }))
  if (disclosure.done !== done) {
    setDisclosure({
      done,
      open: done ? disclosure.open : true,
      pendingCollapse: done && disclosure.open,
    })
  }

  useEffect(() => {
    if (!disclosure.pendingCollapse) return
    const timer = window.setTimeout(() => {
      setDisclosure((current) =>
        current.pendingCollapse ? { ...current, open: false, pendingCollapse: false } : current,
      )
    }, AUTO_COLLAPSE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [disclosure.pendingCollapse])

  const statusText = phaseLabels[phase]
  const collapsedHint = !done && focusStep ? focusStep.title : ''
  const denseTrack = total > 12

  return (
    <section
      className={cn(
        'conversation-block w-full overflow-hidden rounded-xl border border-border/80 bg-card/45 transition-colors duration-200 motion-reduce:transition-none',
        done && !disclosure.open && 'bg-card/30',
      )}
      aria-label="任务进度"
    >
      <div
        aria-hidden="true"
        className={cn(
          'flex px-3 pt-2.5 transition-opacity duration-200 motion-reduce:transition-none',
          denseTrack ? 'gap-0.5' : 'gap-1',
          done && !disclosure.open && 'opacity-70',
        )}
      >
        {progress.steps.map((step) => {
          const stepWorking = step.status === 'in_progress' && canRun
          const segmentClass =
            step.status === 'completed'
              ? 'bg-[var(--color-success)]'
              : step.status === 'blocked'
                ? 'bg-amber-500'
                : step.status === 'in_progress'
                  ? stepWorking
                    ? 'bg-primary task-progress-segment-shimmer'
                    : 'bg-primary/50'
                  : 'bg-border/75'
          return (
            <span
              key={step.id}
              className={cn(
                'h-[3px] flex-1 rounded-full transition-colors duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                segmentClass,
              )}
            />
          )
        })}
      </div>

      <button
        type="button"
        aria-expanded={disclosure.open}
        aria-controls={listId}
        className="flex min-h-9 w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors duration-120 hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => {
          onToggle?.()
          setDisclosure({ done, open: !disclosure.open, pendingCollapse: false })
        }}
      >
        {done ? (
          <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-[var(--color-success)]" />
        ) : phase === 'blocked' ? (
          <AlertCircle aria-hidden="true" className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        ) : (
          <ProgressRing completed={completed} total={total} tone={canRun ? 'primary' : 'muted'} />
        )}

        <span className={cn('shrink-0 text-sm font-medium', done && 'text-muted-foreground')}>任务进度</span>

        {!disclosure.open && collapsedHint ? (
          <>
            <span aria-hidden="true" className="shrink-0 text-muted-foreground/60">
              ·
            </span>
            <CrossfadeText
              className="min-w-0 flex-1"
              textClassName={cn(
                'truncate text-xs',
                isWorking ? 'thought-shimmer font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {collapsedHint}
            </CrossfadeText>
          </>
        ) : (
          <span className="flex-1" />
        )}

        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs tabular-nums" aria-live="polite">
          {statusText && (
            <span
              className={cn(
                phase === 'blocked' &&
                  'rounded-md bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-400',
                phase === 'interrupted' && 'rounded-md bg-destructive/12 px-1.5 py-0.5 font-medium text-destructive',
                phase === 'paused' && 'rounded-md bg-secondary px-1.5 py-0.5 text-muted-foreground',
                done && 'text-[var(--color-success)]',
                phase === 'historical' && 'text-muted-foreground',
              )}
            >
              {statusText}
            </span>
          )}
          <span className="font-mono text-muted-foreground">
            {completed}/{total}
          </span>
        </span>

        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
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
          'grid transition-[grid-template-rows,opacity] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          disclosure.open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <ul className="space-y-1 px-2 pb-2.5 text-sm">
            {progress.steps.map((step) => {
              const active = step.status === 'in_progress'
              const idle = active && !canRun
              const activeWorking = active && canRun
              const blocked = step.status === 'blocked'
              const isCompleted = step.status === 'completed'
              return (
                <li
                  key={step.id}
                  className={cn(
                    'flex items-start gap-2.5 transition-colors duration-200 motion-reduce:transition-none',
                    activeWorking && 'rounded-r-lg border-l-2 border-primary bg-primary/[0.07] py-1.5 pr-2.5 pl-2',
                    idle && 'rounded-r-lg border-l-2 border-muted-foreground/45 bg-secondary/45 py-1.5 pr-2.5 pl-2',
                    blocked && 'rounded-r-lg border-l-2 border-amber-500 bg-amber-500/[0.08] py-1.5 pr-2.5 pl-2',
                    !active && !blocked && 'px-2.5 py-1',
                  )}
                >
                  <StepIndicator step={step} activeWorking={activeWorking} />
                  <div className="min-w-0 flex-1 break-words">
                    <span className="sr-only">{idle ? '上次进行到' : statusLabels[step.status]}，</span>
                    <span
                      className={cn(
                        activeWorking && 'thought-shimmer font-medium text-foreground',
                        idle && 'font-medium text-foreground',
                        blocked && 'font-medium text-foreground',
                        isCompleted && 'text-muted-foreground',
                        step.status === 'pending' && 'text-muted-foreground/80',
                      )}
                    >
                      {step.title}
                    </span>
                    {step.reason && (
                      <p className="mt-0.5 text-xs text-amber-700/90 dark:text-amber-300/90">{step.reason}</p>
                    )}
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

export const TaskProgressCard = memo(TaskProgressCardContent)
