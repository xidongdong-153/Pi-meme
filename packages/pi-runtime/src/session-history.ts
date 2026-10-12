import { readFile, stat } from 'node:fs/promises'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { PiSessionStats, ThinkingLevel } from '@pi-meme/contracts/pi'

import type { SessionHistoryData } from '@pi-meme/contracts/sessions'

import { branchSkillUsages } from './extensions/skill-usage'
import { projectBranchEntries } from './session-tree-entries'
import { projectMessageSources } from './sdk/ui-source'

export type { SessionHistoryData } from '@pi-meme/contracts/sessions'

const cache = new Map<string, { mtime: number; size: number; data: SessionHistoryData }>()
const pending = new Map<string, Promise<SessionHistoryData>>()
const revisions = new Map<string, number>()
export function invalidateSessionHistory(paths: string[]) {
  for (const path of paths) {
    cache.delete(path)
    pending.delete(path)
    revisions.set(path, (revisions.get(path) ?? 0) + 1)
  }
}

function computeHistoryStats(history: SessionEntry[], headerId: string, filePath: string): PiSessionStats {
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

export async function readSessionHistory(filePath: string): Promise<SessionHistoryData> {
  const inFlight = pending.get(filePath)
  if (inFlight) return inFlight
  const revision = revisions.get(filePath) ?? 0
  const request = (async () => {
    const before = await stat(filePath)
    const cached = cache.get(filePath)
    if (cached && cached.mtime === before.mtimeMs && cached.size === before.size) {
      cache.delete(filePath)
      cache.set(filePath, cached)
      return cached.data
    }
    const { parseSessionEntries, migrateSessionEntries, buildSessionContext } =
      await import('@earendil-works/pi-coding-agent')
    const entries = parseSessionEntries(await readFile(filePath, 'utf8'))
    const header = entries.find((entry) => entry.type === 'session')
    if (!header?.cwd) throw new Error('会话文件缺少工作目录')
    // 只迁移内存副本，不使用会改写旧文件的 SessionManager.open。
    migrateSessionEntries(entries)
    const history = entries.filter((entry): entry is SessionEntry => entry.type !== 'session')
    const context = buildSessionContext(history)
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
    const data: SessionHistoryData = {
      cwd: header.cwd,
      created: header.timestamp,
      skillUsages: branchSkillUsages(branch.reverse()),
      messages: projectMessageSources(history, context.messages),
      sessionEntries: {
        entries: projectBranchEntries(history),
        leafId: history.at(-1)?.id ?? null,
      },
      sessionName: sessionName?.type === 'session_info' ? sessionName.name : undefined,
      parentSessionPath: header.parentSession,
      model: context.model ? { provider: context.model.provider, id: context.model.modelId } : undefined,
      thinkingLevel: context.thinkingLevel as ThinkingLevel,
      stats: computeHistoryStats(history, header.id, filePath),
    }
    const after = await stat(filePath)
    if (revision === (revisions.get(filePath) ?? 0) && before.mtimeMs === after.mtimeMs && before.size === after.size) {
      cache.delete(filePath)
      if (cache.size >= 20) cache.delete(cache.keys().next().value!)
      cache.set(filePath, { mtime: before.mtimeMs, size: before.size, data })
    }
    return data
  })()
  pending.set(filePath, request)
  try {
    return await request
  } finally {
    if (pending.get(filePath) === request) pending.delete(filePath)
  }
}

export async function prefetchSessionHistory(filePath: string): Promise<void> {
  try {
    await readSessionHistory(filePath)
  } catch {
    // 悬停预读失败时，点击会话仍会重新读取并显示错误。
  }
}
