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

/** 首次输入定义任务身份；续做只移动该任务在当前分支的展示位置。 */
export function latestTaskProgress(messages: readonly unknown[]) {
  const tasks = new Map<string, TaskProgress>()
  for (const message of messages) {
    const progress = readTaskProgress(message)
    if (progress) tasks.set(progress.taskId, progress)
  }
  return tasks
}
