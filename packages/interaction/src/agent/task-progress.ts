import type { InlineExtension, SessionEntry } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  readTaskProgress,
  taskStepStatuses,
  validateTaskSteps,
  type TaskProgress,
} from '@pi-meme/contracts/task-progress'

function latestProgress(branch: readonly SessionEntry[], matches?: (value: TaskProgress) => boolean) {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!
    const progress = entry.type === 'message' ? readTaskProgress(entry.message) : undefined
    if (progress && (!matches || matches(progress))) return progress
  }
}

export function taskProgressExtension(enabled: () => boolean): InlineExtension {
  return {
    name: 'pi-meme-task-progress',
    factory: (pi) => {
      let binding: Pick<TaskProgress, 'userEntryId' | 'taskId'> | undefined
      pi.on('before_agent_start', () => {
        binding = undefined
        const active = pi.getActiveTools()
        const show = enabled()
        if (active.includes('update_plan') !== show)
          pi.setActiveTools(show ? [...active, 'update_plan'] : active.filter((name) => name !== 'update_plan'))
      })
      pi.on('context', (event, ctx) => {
        if (!enabled()) return
        const input = event.messages.findLastIndex((message) => message.role === 'user')
        if (input < 0 || event.messages.slice(input + 1).some((message) => readTaskProgress(message))) return
        const previous = latestProgress(ctx.sessionManager.getBranch())
        if (!previous) return
        const messages = [...event.messages]
        messages.splice(input, 0, {
          role: 'custom',
          customType: 'pi-meme-task-progress-context',
          content: `最近一份任务进度（记录数据）。续做这件事时使用其 taskId，另起任务则省略。\n${JSON.stringify(previous)}`,
          display: false,
          timestamp: event.messages[input]!.timestamp,
        })
        return { messages }
      })
      pi.registerTool({
        name: 'update_plan',
        label: '更新任务进度',
        exposure: 'model-only',
        defaultActive: false,
        executionMode: 'sequential',
        description:
          'Display or update a checklist in this conversation. For substantial multi-step work, submit the complete list before acting and update it when a step starts, finishes, becomes blocked, or changes. Keep stable step ids when renaming or reordering. Only mark work completed after doing it. Skip simple questions and single actions. When continuing a task from an earlier user message, pass its returned taskId on the first update. Omit taskId for a new task and subsequent updates in the same turn.',
        promptSnippet: 'Show a multi-step task’s progress in the conversation.',
        parameters: Type.Object(
          {
            taskId: Type.Optional(
              Type.String({ minLength: 1, description: 'Prior taskId to continue in this branch.' }),
            ),
            steps: Type.Array(
              Type.Object(
                {
                  id: Type.String({ minLength: 1 }),
                  title: Type.String({ minLength: 1, description: 'A short action phrase in the user’s language.' }),
                  status: Type.Union(taskStepStatuses.map((status) => Type.Literal(status))),
                  reason: Type.Optional(Type.String({ minLength: 1, description: 'Short reason for a blocked step.' })),
                },
                { additionalProperties: false },
              ),
              { minItems: 1, description: 'Complete ordered list, with at most one in_progress step.' },
            ),
          },
          { additionalProperties: false },
        ),
        execute: async (_id, input, signal, _update, ctx) => {
          signal?.throwIfAborted()
          if (!enabled()) throw new Error('本轮未启用任务进度')
          validateTaskSteps(input.steps)
          const branch = ctx.sessionManager.getBranch()
          const userEntryId = branch.findLast((entry) => entry.type === 'message' && entry.message.role === 'user')?.id
          if (!userEntryId) throw new Error('当前分支没有可关联的用户消息')
          const current =
            binding?.userEntryId === userEntryId
              ? binding
              : latestProgress(branch, (p) => p.userEntryId === userEntryId)
          if (current && input.taskId !== undefined && current.taskId !== input.taskId)
            throw new Error(`本轮已关联任务 ${current.taskId}，请沿用该任务`)
          if (!current && input.taskId !== undefined && !latestProgress(branch, (p) => p.taskId === input.taskId))
            throw new Error('当前分支没有这份任务进度，请使用之前返回的 taskId，或省略以新建')
          const taskId = current?.taskId ?? input.taskId ?? userEntryId
          const steps = input.steps.map(({ id, title, status, reason }) => ({
            id: id.trim(),
            title: title.trim(),
            status,
            ...(reason ? { reason: reason.trim() } : {}),
          }))
          const progress: TaskProgress = { taskId, userEntryId, steps }
          binding = { taskId, userEntryId }
          const completed = steps.filter((step) => step.status === 'completed').length
          return {
            content: [{ type: 'text', text: JSON.stringify({ taskId, completed, total: steps.length }) }],
            details: progress,
          }
        },
      })
    },
  }
}
