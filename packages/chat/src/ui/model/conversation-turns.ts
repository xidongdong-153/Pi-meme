import { nestedTools } from './nested-tools'
import type { PiImage, PiMessage, PiRunInterval } from '@pi-meme/contracts/pi'
import type { ActivityItem, ChatState, TurnChunk } from './types'

type RawTurnItem = { kind: 'activity'; item: ActivityItem } | { kind: 'text'; text: string }

/** 按交互轮次（Turn）聚合整个对话流中的所有思考、工具调用与最终文本 */
export function groupConversationTurns(
  messages: PiMessage[],
  liveMessage: PiMessage | null,
  toolsMap: ChatState['tools'],
  isAgentRunning: boolean,
  completed: Record<number, boolean> = {},
  agentStatuses: Array<Extract<TurnChunk, { type: 'agent_status' }>> = [],
  runIntervals: readonly PiRunInterval[] = [],
): TurnChunk[] {
  // Pi 的 get_messages 会把 compactionSummary 与 branchSummary 强制放在数组首位作为模型上下文。
  // 但其真实 timestamp 记录了压缩发生的真实时刻。按 timestamp 稳定排序，
  // 确保压缩卡片精准呈现在发生压缩的时序位置（即最后一条 Pi 消息下方、输入框上方），而非会话最顶部。
  // 没有 timestamp 的消息沿用前一条的排序键，保持原有相对位置，避免被排到会话最前。
  const baseMessages: PiMessage[] = liveMessage ? [...messages, liveMessage] : [...messages]
  let sortKey = 0
  const allMessages = baseMessages
    .map((message) => {
      if (typeof message.timestamp === 'number') sortKey = message.timestamp
      return { message, sortKey }
    })
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((entry) => entry.message)
  const chunks: TurnChunk[] = []

  const assignedToolIds = new Set<string>()
  for (const msg of allMessages) {
    if ('content' in msg && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'toolCall' && part.id) {
          assignedToolIds.add(part.id)
        }
      }
    }
  }

  const unassignedTools: ActivityItem[] = Object.values(toolsMap)
    .filter((t) => !t.parentToolCallId && !assignedToolIds.has(t.id))
    .map((t) => ({
      id: t.id,
      type: 'tool' as const,
      name: t.name,
      source: t.source,
      args: t.args,
      result: t.result,
      status: t.status,
      children: nestedTools(t.id, toolsMap),
    }))

  let turnItems: RawTurnItem[] = []
  let turnImages: Array<PiImage & { id?: string }> = []
  let turnErrorMessage: string | undefined
  let turnStartTimestamp: number | undefined
  let turnEndTimestamp: number | undefined
  let turnKey = ''

  const flushTurn = (isLastTurn: boolean, boundary?: number) => {
    if (isLastTurn && unassignedTools.length > 0) {
      for (const toolItem of unassignedTools) {
        turnItems.push({ kind: 'activity', item: toolItem })
      }
    }

    let lastWorkIdx = -1
    for (let i = turnItems.length - 1; i >= 0; i--) {
      if (turnItems[i]!.kind === 'activity') {
        lastWorkIdx = i
        break
      }
    }

    const activities: ActivityItem[] = []
    const finalTextParts: string[] = []

    if (lastWorkIdx === -1) {
      for (const item of turnItems) {
        if (item.kind === 'text' && item.text) {
          finalTextParts.push(item.text)
        }
      }
    } else {
      for (let i = 0; i <= lastWorkIdx; i++) {
        const item = turnItems[i]!
        if (item.kind === 'activity') {
          activities.push(item.item)
        } else if (item.kind === 'text' && item.text.trim()) {
          activities.push({
            id: `narration-${i}`,
            type: 'narration',
            text: item.text.trim(),
          })
        }
      }
      for (let i = lastWorkIdx + 1; i < turnItems.length; i++) {
        const item = turnItems[i]!
        if (item.kind === 'text' && item.text) {
          finalTextParts.push(item.text)
        }
      }
    }

    const finalText = finalTextParts.join('\n\n').trim()
    const isLive = isLastTurn && (isAgentRunning || Boolean(liveMessage))
    const hasWorkOrText = activities.length > 0 || Boolean(finalText) || Boolean(turnErrorMessage)

    if (hasWorkOrText || isLive) {
      const run = runIntervals.findLast(
        (interval) =>
          turnStartTimestamp !== undefined &&
          interval.startedAt < (boundary ?? Infinity) &&
          (interval.endedAt ?? Infinity) > turnStartTimestamp,
      )
      const hasPendingTools = activities.some(
        (item) => item.type !== 'thinking' && item.type !== 'narration' && item.status === 'running',
      )
      const finishedAt =
        run?.endedAt !== undefined
          ? Math.min(run.endedAt, boundary ?? Infinity)
          : hasPendingTools
            ? undefined
            : turnEndTimestamp
      const durationMs =
        turnStartTimestamp !== undefined && finishedAt !== undefined
          ? Math.max(0, finishedAt - turnStartTimestamp)
          : undefined

      chunks.push({
        type: 'assistant_turn',
        activities,
        finalText,
        images: turnImages,
        errorMessage: turnErrorMessage,
        durationMs,
        startedAt: turnStartTimestamp,
        isLive,
        key: turnKey || `turn-assistant-${chunks.length}`,
      })
    }

    turnItems = []
    turnImages = []
    turnErrorMessage = undefined
    turnStartTimestamp = undefined
    turnEndTimestamp = undefined
    turnKey = ''
  }

  let timelineKey = 0
  const timeline = [
    ...allMessages.map((message) => {
      if (typeof message.timestamp === 'number') timelineKey = message.timestamp
      return { type: 'message' as const, message, timestamp: timelineKey }
    }),
    ...agentStatuses.map((status) => ({ type: 'status' as const, status, timestamp: status.timestamp })),
  ].sort((a, b) => a.timestamp - b.timestamp)
  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i]!
    if (item.type === 'status') {
      flushTurn(false, item.timestamp)
      chunks.push(item.status)
      continue
    }
    const msg = item.message
    if (!msg || msg.role === 'system') continue
    if (msg.role === 'custom' && !msg.display) continue

    if (msg.role === 'user') {
      flushTurn(false, msg.timestamp)
      chunks.push({
        type: 'user',
        message: msg,
        key: `user-${msg.timestamp ?? i}-${i}`,
      })
      turnKey = `turn-${msg.timestamp ?? i}-${i}`
      turnStartTimestamp = msg.timestamp
      continue
    }

    if (msg.role === 'compactionSummary' || msg.role === 'branchSummary') {
      flushTurn(false, msg.timestamp)
      chunks.push({
        type: 'compaction',
        kind: msg.role === 'compactionSummary' ? 'compaction' : 'branch_summary',
        summary: msg.summary,
        tokensBefore: 'tokensBefore' in msg ? msg.tokensBefore : undefined,
        timestamp: msg.timestamp,
        key: `${msg.role}-${msg.timestamp ?? i}-${i}`,
      })
      turnKey = `turn-${msg.timestamp ?? i}-${i}`
      turnStartTimestamp = msg.timestamp
      continue
    }

    if (msg.role === 'custom') {
      flushTurn(false, msg.timestamp)
      chunks.push({ type: 'custom', message: msg, key: `custom-${msg.timestamp ?? i}-${i}` })
      continue
    }

    if (msg.role === 'toolResult') {
      if (msg.timestamp) {
        turnEndTimestamp = Math.max(turnEndTimestamp || 0, msg.timestamp)
      }
      continue
    }

    if (!turnKey) {
      turnKey = `turn-init-${msg.timestamp ?? i}-${i}`
    }

    if (msg.timestamp) {
      if (!turnStartTimestamp) turnStartTimestamp = msg.timestamp
      turnEndTimestamp = Math.max(turnEndTimestamp || 0, msg.completedAt ?? msg.timestamp)
    }

    if (msg.role === 'assistant' && msg.errorMessage) {
      turnErrorMessage = msg.errorMessage
    }

    if (msg.role === 'bashExecution') {
      turnItems.push({
        kind: 'activity',
        item: {
          id: String(msg.timestamp ?? `bash-${i}`),
          type: 'tool',
          name: 'bash',
          command: msg.command,
          output: msg.output,
          status: 'success',
        },
      })
      continue
    }

    if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        for (let pIdx = 0; pIdx < msg.content.length; pIdx++) {
          const part = msg.content[pIdx]!
          if (part.type === 'toolCall' && part.id) {
            const toolRun = toolsMap[part.id]
            turnItems.push({
              kind: 'activity',
              item: {
                id: part.id,
                type: 'tool',
                name: part.name,
                source: toolRun?.source,
                args: part.arguments,
                result: toolRun?.result,
                children: nestedTools(part.id, toolsMap),
                status: toolRun?.status || (isAgentRunning ? 'running' : 'success'),
              },
            })
          } else if (part.type === 'thinking') {
            if (part.thinking?.trim()) {
              turnItems.push({
                kind: 'activity',
                item: {
                  id: `thinking-${i}-${pIdx}`,
                  type: 'thinking',
                  thinking: part.thinking,
                  status: msg === liveMessage && isAgentRunning && !completed[pIdx] ? 'running' : 'success',
                },
              })
            }
          } else if (part.type === 'text') {
            if (part.text) {
              turnItems.push({ kind: 'text', text: part.text })
            }
          }
        }
      } else if (typeof msg.content === 'string') {
        if (msg.content) {
          turnItems.push({ kind: 'text', text: msg.content })
        }
      }
    }
  }

  flushTurn(true)
  const grouped: TurnChunk[] = []
  for (const chunk of chunks) {
    const previous = grouped.at(-1)
    if (
      chunk.type === 'agent_status' &&
      chunk.phase === 'finished' &&
      chunk.status === '已完成' &&
      previous?.type === 'agent_status' &&
      previous.phase === 'finished' &&
      previous.status === '已完成' &&
      !chunk.agents.some((agent) => previous.agents.some((entry) => entry.agentId === agent.agentId))
    ) {
      grouped[grouped.length - 1] = { ...previous, agents: [...previous.agents, ...chunk.agents] }
    } else grouped.push(chunk)
  }
  return grouped
}
