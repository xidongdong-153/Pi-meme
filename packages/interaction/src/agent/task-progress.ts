import { isDeepStrictEqual } from 'node:util'
import type { InlineExtension, SessionEntry } from '@earendil-works/pi-coding-agent'
import { loadPiSdk, type PiSdk } from '@pi-meme/pi-runtime/sdk/load'
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
    if (progress && (!matches || matches(progress))) return { entryId: entry.id, progress }
  }
}

function savedSteps(input: unknown) {
  validateTaskSteps(input)
  return input.map(({ id, title, status, reason }) => ({
    id: id.trim(),
    title: title.trim(),
    status,
    ...(reason ? { reason: reason.trim() } : {}),
  }))
}

function containsTaskId(text: string, taskId: string) {
  try {
    return JSON.parse(text)?.taskId === taskId
  } catch {
    return false
  }
}

/** The branch ends at the compaction entry. Later turns must reproduce the same summary prefix. */
function missingCompactedProgress(branch: SessionEntry[], sdk: PiSdk) {
  const latest = latestProgress(branch)
  if (!latest) return
  const { progress } = latest
  const kept = sdk.buildSessionProjection(branch).entries
  const resultIndex = kept.findIndex(({ sourceEntry }) => sourceEntry.id === latest.entryId)
  const result = kept[resultIndex]?.messages[0]
  if (
    result?.role !== 'toolResult' ||
    !result.content.some((part) => part.type === 'text' && containsTaskId(part.text, progress.taskId))
  )
    return progress

  // The model gets the steps from the call and the task ID from its successful result.
  for (let index = resultIndex - 1; index >= 0; index--) {
    const message = kept[index]!.messages[0]
    if (message?.role !== 'assistant' || message.stopReason === 'aborted' || message.stopReason === 'error') continue
    const call = message.content.find((part) => part.type === 'toolCall' && part.id === result.toolCallId)
    if (call?.type !== 'toolCall') continue
    if (call.name === 'update_plan') {
      try {
        if (isDeepStrictEqual(savedSteps(call.arguments.steps), progress.steps)) return
      } catch {
        // An edited or imported call can have incomplete arguments.
      }
    }
    break
  }
  return progress
}

export function taskProgressExtension(enabled: () => boolean): InlineExtension {
  return {
    name: 'pi-meme-task-progress',
    factory: async (pi) => {
      const sdk = await loadPiSdk()
      let binding: Pick<TaskProgress, 'userEntryId' | 'taskId'> | undefined
      let checkpoint: { sessionId: string; entryId: string; progress?: TaskProgress } | undefined
      pi.on('before_agent_start', () => {
        binding = undefined
        const active = pi.getActiveTools()
        const show = enabled()
        if (active.includes('update_plan') !== show)
          pi.setActiveTools(show ? [...active, 'update_plan'] : active.filter((name) => name !== 'update_plan'))
      })
      pi.on('context_with_system', (event, ctx) => {
        if (!enabled()) return
        const summaryIndex = event.messages.findLastIndex((message) => message.role === 'compactionSummary')
        if (summaryIndex < 0) return
        const branch = ctx.sessionManager.getBranch()
        const boundary = branch.findLastIndex((entry) => entry.type === 'compaction')
        const compaction = branch[boundary]
        if (!compaction) return
        const sessionId = ctx.sessionManager.getSessionId()
        if (checkpoint?.entryId !== compaction.id || checkpoint.sessionId !== sessionId)
          checkpoint = {
            sessionId,
            entryId: compaction.id,
            progress: missingCompactedProgress(branch.slice(0, boundary + 1), sdk),
          }
        if (!checkpoint.progress) return
        const messages = [...event.messages]
        messages.splice(summaryIndex + 1, 0, {
          role: 'custom',
          customType: 'pi-meme-task-progress-context',
          content: `压缩时的任务进度（记录数据）。续做时使用其 taskId，更新后的进度见后续工具记录。\n${JSON.stringify(checkpoint.progress)}`,
          display: false,
          timestamp: event.messages[summaryIndex]!.timestamp,
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
          const steps = savedSteps(input.steps)
          const branch = ctx.sessionManager.getBranch()
          const userEntryId = branch.findLast((entry) => entry.type === 'message' && entry.message.role === 'user')?.id
          if (!userEntryId) throw new Error('当前分支没有可关联的用户消息')
          const current =
            binding?.userEntryId === userEntryId
              ? binding
              : latestProgress(branch, (p) => p.userEntryId === userEntryId)?.progress
          if (current && input.taskId !== undefined && current.taskId !== input.taskId)
            throw new Error(`本轮已关联任务 ${current.taskId}，请沿用该任务`)
          if (!current && input.taskId !== undefined && !latestProgress(branch, (p) => p.taskId === input.taskId))
            throw new Error('当前分支没有这份任务进度，请使用之前返回的 taskId，或省略以新建')
          const taskId = current?.taskId ?? input.taskId ?? userEntryId
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
