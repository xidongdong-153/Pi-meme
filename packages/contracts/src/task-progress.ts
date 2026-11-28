import { sessionExecutionPhase, type PiMessage, type PiState } from './pi'

export const taskStepStatuses = ['pending', 'in_progress', 'completed', 'blocked'] as const
export type TaskStepStatus = (typeof taskStepStatuses)[number]
export type TaskStep = { id: string; title: string; status: TaskStepStatus; reason?: string }
export type TaskProgress = { taskId: string; userEntryId: string; steps: TaskStep[] }

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function validateTaskSteps(value: unknown): asserts value is TaskStep[] {
  if (!Array.isArray(value) || !value.length) throw new Error('请提交至少一个步骤的完整清单')
  const ids = new Set<string>()
  let active = false
  for (const step of value) {
    if (!step || !nonblank(step.id) || !nonblank(step.title)) throw new Error('每个步骤都需要非空的 id 和标题')
    if (ids.has(step.id.trim())) throw new Error(`步骤 id 重复：${step.id}`)
    ids.add(step.id.trim())
    if (!taskStepStatuses.includes(step.status)) throw new Error(`步骤状态无效：${step.id}`)
    if (step.status === 'in_progress') {
      if (active) throw new Error('最多只能有一个进行中的步骤')
      active = true
    }
    if (step.reason !== undefined && (step.status !== 'blocked' || !nonblank(step.reason)))
      throw new Error('只有受阻步骤可以填写原因，原因必须是非空文字')
  }
}

/** Only successful native tool results carry a committed snapshot. */
export function readTaskProgress(message: unknown): TaskProgress | undefined {
  const result = message as {
    role?: string
    toolName?: string
    isError?: boolean
    details?: Partial<TaskProgress>
  } | null
  if (result?.role !== 'toolResult' || result.toolName !== 'update_plan' || result.isError) return
  const progress = result.details
  if (!progress || !nonblank(progress.taskId) || !nonblank(progress.userEntryId)) return
  try {
    validateTaskSteps(progress.steps)
    return progress as TaskProgress
  } catch {
    return undefined
  }
}

/** Native results can be delivered again after a retry. The first commit for a call owns its receipt. */
export function* taskProgressUpdates<T>(records: readonly T[], messageOf: (record: T) => unknown) {
  const calls = new Map<string, Set<string>>()
  for (const record of records) {
    const message = messageOf(record)
    const progress = readTaskProgress(message)
    if (!progress) continue
    const { toolCallId } = message as { toolCallId?: string }
    if (nonblank(toolCallId)) {
      let ids = calls.get(progress.userEntryId)
      if (!ids) {
        ids = new Set()
        calls.set(progress.userEntryId, ids)
      }
      if (ids.has(toolCallId)) continue
      ids.add(toolCallId)
    }
    yield { record, progress, toolCallId }
  }
}

function branchTaskIndex(messages: readonly unknown[]) {
  const tasks = new Map<string, TaskProgress>()
  const lastTaskByUser = new Map<string, string>()
  for (const { progress } of taskProgressUpdates(messages, (message) => message)) {
    tasks.set(progress.taskId, progress)
    lastTaskByUser.set(progress.userEntryId, progress.taskId)
  }
  return { tasks, lastTaskByUser }
}

/** The task keeps its identity when a later user turn continues it on the same branch. */
export function latestTaskProgress(messages: readonly unknown[]) {
  return branchTaskIndex(messages).tasks
}

export function completedTaskSteps(steps: readonly TaskStep[]) {
  return steps.filter((step) => step.status === 'completed').length
}

export type TaskProgressPhase = 'historical' | 'running' | 'paused' | 'interrupted' | 'completed' | 'blocked'
export type TaskProgressView = TaskProgress & {
  phase: TaskProgressPhase
  completed: number
  focusStepId?: string
}

type Execution = Pick<
  PiState,
  'executionPhase' | 'isStreaming' | 'isCompacting' | 'isPaused' | 'stopped' | 'retry' | 'runIntervals'
>

export function isTaskContinuation(message: PiMessage) {
  return (
    message.role === 'custom' &&
    !message.display &&
    (message.customType === 'pi-meme-stopped-control' || message.customType === 'pi-meme-recovery-control')
  )
}

function runningOwner(execution: Execution, owner: string | undefined, lastActivity: PiMessage | undefined) {
  if (sessionExecutionPhase(execution) !== 'running') return
  const run = execution.runIntervals?.at(-1)
  if (run?.endedAt !== undefined) return
  if (run?.userEntryId !== undefined) return run.userEntryId ?? undefined
  // Older Hosts supplied time intervals or just SDK flags. Use only activity from the tail turn.
  if (!lastActivity) return
  if (execution.retry?.kind === 'model' || isTaskContinuation(lastActivity)) return owner
  if (run) return lastActivity.timestamp >= run.startedAt ? owner : undefined
  if (
    lastActivity.role === 'toolResult' ||
    lastActivity.role === 'user' ||
    (lastActivity.role === 'assistant' && lastActivity.stopReason === 'toolUse')
  )
    return owner
}

/** Receives native messages in branch order. Chat pagination prepends complete turns to the tail window. */
export function projectTaskProgress(messages: readonly PiMessage[], execution: Execution): TaskProgressView[] {
  const { tasks, lastTaskByUser } = branchTaskIndex(messages)
  if (!tasks.size) return []

  const interrupted = new Set<string>()
  let owner: string | undefined
  let lastActivity: PiMessage | undefined
  for (const message of messages) {
    if (message.role === 'user') owner = message.sourceEntry?.id
    if (message.role === 'toolResult' && !owner) owner = readTaskProgress(message)?.userEntryId
    const resumed = isTaskContinuation(message)
    if (message.role === 'assistant' && owner) {
      if (message.stopReason === 'aborted' || message.stopReason === 'error') interrupted.add(owner)
      else interrupted.delete(owner)
    } else if (resumed && owner) interrupted.delete(owner)
    if (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult' || resumed)
      lastActivity = message
  }
  const activeOwner = runningOwner(execution, owner, lastActivity)

  return [...tasks.values()].map((progress) => {
    const completed = completedTaskSteps(progress.steps)
    const active = progress.steps.find((step) => step.status === 'in_progress')
    const blocked = progress.steps.find((step) => step.status === 'blocked')
    const focus = active ?? blocked ?? progress.steps.find((step) => step.status === 'pending')
    const latestInTurn = lastTaskByUser.get(progress.userEntryId) === progress.taskId
    const current = latestInTurn && progress.userEntryId === owner
    const running = current && progress.userEntryId === activeOwner
    let phase: TaskProgressPhase = 'historical'
    if (completed === progress.steps.length) phase = 'completed'
    else if (current && execution.stopped) phase = 'interrupted'
    else if (running && execution.isPaused) phase = 'paused'
    else if (latestInTurn && interrupted.has(progress.userEntryId) && !running) phase = 'interrupted'
    else if (!active && blocked) phase = 'blocked'
    else if (running) phase = 'running'
    return { ...progress, phase, completed, ...(focus ? { focusStepId: focus.id } : {}) }
  })
}
