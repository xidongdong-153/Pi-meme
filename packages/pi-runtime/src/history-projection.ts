import type { SessionEntry, SessionHeader } from '@earendil-works/pi-coding-agent'
import type { PiSessionStats, ThinkingLevel } from '@pi-meme/contracts/pi'
import { projectBranchPlans, type QueuedInput } from '@pi-meme/contracts/plan'

import type { SessionHistoryData } from '@pi-meme/contracts/sessions'

import { branchSkillUsages } from './extensions/skill-usage'
import { projectBranchEntries } from './session-tree-entries'
import { projectBranchAttachments } from './session-attachments'
import { projectStableMessageMetadata } from './sdk/message-projection'
import { loadPiSdk } from './sdk/load'
import { findSessionRecovery } from './sdk/recovery'

export function computeHistoryStats(history: SessionEntry[], headerId: string, filePath: string): PiSessionStats {
  let userMessages = 0
  let assistantMessages = 0
  let toolResults = 0
  let totalMessages = 0
  let toolCalls = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let totalCost = 0
  let lastAssistantUsage:
    { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } | undefined

  for (const entry of history) {
    if (entry.type === 'usage' || entry.type === 'branch_summary' || entry.type === 'compaction') {
      const u = (
        entry as {
          usage?: {
            input?: number
            output?: number
            cacheRead?: number
            cacheWrite?: number
            cost?: { total?: number }
          }
        }
      ).usage
      if (u) {
        inputTokens += u.input ?? 0
        outputTokens += u.output ?? 0
        cacheReadTokens += u.cacheRead ?? 0
        cacheWriteTokens += u.cacheWrite ?? 0
        totalCost += u.cost?.total ?? 0
      }
    }
    if (entry.type !== 'message') continue
    totalMessages++
    const message = entry.message
    if (message.role === 'user') {
      userMessages++
    } else if (message.role === 'toolResult') {
      toolResults++
      const u = (
        message as {
          usage?: {
            input?: number
            output?: number
            cacheRead?: number
            cacheWrite?: number
            cost?: { total?: number }
          }
        }
      ).usage
      if (u) {
        inputTokens += u.input ?? 0
        outputTokens += u.output ?? 0
        cacheReadTokens += u.cacheRead ?? 0
        cacheWriteTokens += u.cacheWrite ?? 0
        totalCost += u.cost?.total ?? 0
      }
    } else if (message.role === 'assistant') {
      assistantMessages++
      if (Array.isArray(message.content)) {
        toolCalls += message.content.filter((c: { type?: string }) => c.type === 'toolCall').length
      }
      const u = (
        message as {
          usage?: {
            input?: number
            output?: number
            cacheRead?: number
            cacheWrite?: number
            totalTokens?: number
            cost?: { total?: number }
          }
        }
      ).usage
      if (u) {
        inputTokens += u.input ?? 0
        outputTokens += u.output ?? 0
        cacheReadTokens += u.cacheRead ?? 0
        cacheWriteTokens += u.cacheWrite ?? 0
        totalCost += u.cost?.total ?? 0
        if (u.totalTokens || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) > 0) {
          lastAssistantUsage = u
        }
      }
    }
  }

  const contextTokens = lastAssistantUsage
    ? lastAssistantUsage.totalTokens ||
      (lastAssistantUsage.input ?? 0) +
        (lastAssistantUsage.output ?? 0) +
        (lastAssistantUsage.cacheRead ?? 0) +
        (lastAssistantUsage.cacheWrite ?? 0)
    : 0
  const contextWindow = 256000
  const percent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0

  return {
    sessionFile: filePath,
    sessionId: headerId,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
      total: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    },
    cost: totalCost,
    contextUsage: {
      tokens: contextTokens,
      contextWindow,
      percent,
    },
  }
}

export async function projectSessionHistory(
  filePath: string,
  entries: Array<SessionHeader | SessionEntry>,
): Promise<SessionHistoryData> {
  const { buildSessionProjection } = await loadPiSdk()
  const header = entries.find((entry): entry is SessionHeader => entry.type === 'session')
  if (!header?.cwd) throw new Error('会话文件缺少工作目录')
  const history = entries.filter((entry): entry is SessionEntry => entry.type !== 'session')
  const context = buildSessionProjection(history)
  const sessionName = history.findLast((entry) => entry.type === 'session_info')
  const byId = new Map(history.map((entry) => [entry.id, entry]))
  const branch: SessionEntry[] = []
  let branchEntry = history.at(-1)
  const branchIds = new Set<string>()
  while (branchEntry && !branchIds.has(branchEntry.id)) {
    branchIds.add(branchEntry.id)
    branch.push(branchEntry)
    branchEntry = branchEntry.parentId ? byId.get(branchEntry.parentId) : undefined
  }
  branch.reverse()
  const control = branch.findLast((entry) => entry.type === 'custom' && entry.customType === 'pi-meme-task-control')
  const controlData = control?.type === 'custom' ? (control.data as Record<string, unknown>) : undefined
  const taskControl: SessionHistoryData['taskControl'] =
    controlData &&
    typeof controlData === 'object' &&
    Array.isArray(controlData.steering) &&
    Array.isArray(controlData.followUp)
      ? {
          stopped: controlData.stopped === true,
          steering: [...controlData.steering],
          followUp: [...controlData.followUp],
        }
      : undefined
  const delivering = controlData?.delivering as { kind?: 'steering' | 'followUp'; input?: QueuedInput } | undefined
  if (taskControl && delivering?.input?.id && (delivering.kind === 'steering' || delivering.kind === 'followUp'))
    taskControl[delivering.kind].unshift({ ...delivering.input, deliveryUncertain: true })
  const recovery = findSessionRecovery(history, history.at(-1)?.id ?? null)
  const data: SessionHistoryData = {
    cwd: header.cwd,
    created: header.timestamp,
    skillUsages: branchSkillUsages(branch),
    recovery: recovery ? { entryId: recovery.entryId, mode: recovery.mode } : undefined,
    taskControl,
    messages: projectStableMessageMetadata(history, context),
    planCheckpoints: projectBranchPlans(history, history.at(-1)?.id ?? null),
    sessionEntries: {
      entries: projectBranchEntries(history),
      leafId: history.at(-1)?.id ?? null,
    },
    branchAttachments: projectBranchAttachments(history, history.at(-1)?.id ?? null),
    sessionName: sessionName?.type === 'session_info' ? sessionName.name : undefined,
    parentSessionPath: header.parentSession,
    model: context.model ? { provider: context.model.provider, id: context.model.modelId } : undefined,
    thinkingLevel: context.thinkingLevel as ThinkingLevel,
    stats: computeHistoryStats(history, header.id, filePath),
  }
  return data
}
