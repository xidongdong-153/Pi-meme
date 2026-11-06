import { nestedTools, toolTreeIndex } from './nested-tools'
import { retainTurns, sameItems } from './stable-turns'
import type { PiImage, PiMessage, PiRunInterval } from '@pi-meme/contracts/pi'
import type { ActivityItem, ChatState, TurnChunk } from './types'

type RawTurnItem = { kind: 'activity'; item: ActivityItem } | { kind: 'text'; text: string; message?: PiMessage }
type GroupBoundary = { last: boolean; timestamp?: number; assigned: ReadonlySet<string> }
const emptyCompleted: Record<number, boolean> = {}
const emptyIntervals: readonly PiRunInterval[] = []
const emptyStatuses: Array<Extract<TurnChunk, { type: 'agent_status' }>> = []
const emptyChanges: Array<Extract<TurnChunk, { type: 'model_change' }>> = []

/** 按交互轮次（Turn）聚合整个对话流中的所有思考、工具调用与最终文本 */
export function groupConversationTurns(
  messages: PiMessage[],
  liveMessage: PiMessage | null,
  toolsMap: ChatState['tools'],
  isAgentRunning: boolean,
  completed: Record<number, boolean> = {},
  agentStatuses: Array<Extract<TurnChunk, { type: 'agent_status' }>> = [],
  runIntervals: readonly PiRunInterval[] = [],
  modelChanges: Array<Extract<TurnChunk, { type: 'model_change' }>> = [],
  messageOffset = 0,
  boundary?: GroupBoundary,
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

  const assignedToolIds = boundary?.assigned ?? assignedTools(allMessages)
  const unassignedTools: ActivityItem[] = (boundary?.last === false ? [] : toolTreeIndex(toolsMap).values)
    .filter((t) => !t.parentToolCallId && !assignedToolIds.has(t.id))
    .map((t) => ({
      id: t.id,
      type: 'tool' as const,
      name: t.name,
      source: t.source,
      sourceEntry: t.sourceEntry,
      args: t.args,
      result: t.result,
      status: t.status,
      children: nestedTools(t.id, toolsMap),
    }))

  let turnItems: RawTurnItem[] = []
  let sourceMessages: PiMessage[] = []
  let turnImages: Array<PiImage & { id?: string }> = []
  let turnErrorMessage: string | undefined
  let turnStartTimestamp: number | undefined
  let turnEndTimestamp: number | undefined
  let turnKey = ''
  // 展示段会被子代理状态、压缩和可见自定义消息切开；分叉要保留打开这轮的用户消息，不能随段重置。
  let userMessageTimestamp: number | undefined
  let userEntryId: string | undefined

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
    const finalReplyMessages = [
      ...new Set(
        turnItems
          .slice(lastWorkIdx + 1)
          .flatMap((item) => (item.kind === 'text' && item.message ? [item.message] : [])),
      ),
    ]
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
      const replyMessage = finalReplyMessages.at(-1)
      const repliedAt = replyMessage?.completedAt ?? replyMessage?.timestamp ?? turnEndTimestamp

      chunks.push({
        type: 'assistant_turn',
        activities,
        finalText,
        sourceMessages,
        finalReplyMessages,
        images: turnImages,
        errorMessage: turnErrorMessage,
        durationMs,
        startedAt: turnStartTimestamp,
        ...(typeof userMessageTimestamp === 'number' ? { userTimestamp: userMessageTimestamp } : {}),
        ...(userEntryId ? { userEntryId } : {}),
        ...(repliedAt !== undefined ? { repliedAt } : {}),
        isLive,
        key: turnKey || `turn-assistant-${chunks.length}`,
      })
    }

    turnItems = []
    sourceMessages = []
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
    ...modelChanges.map((change) => ({ type: 'model_change' as const, change, timestamp: change.timestamp })),
  ].sort((a, b) => a.timestamp - b.timestamp)
  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i]!
    if (item.type === 'status') {
      flushTurn(false, item.timestamp)
      chunks.push(item.status)
      continue
    }
    if (item.type === 'model_change') {
      flushTurn(false, item.timestamp)
      chunks.push(item.change)
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
        key: `user-${msg.timestamp ?? i}-${i + messageOffset}`,
      })
      turnKey = `turn-${msg.timestamp ?? i}-${i + messageOffset}`
      turnStartTimestamp = msg.timestamp
      userMessageTimestamp = typeof msg.timestamp === 'number' ? msg.timestamp : undefined
      userEntryId = msg.sourceEntry?.id
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
      turnKey = `turn-init-${msg.timestamp ?? i}`
    }

    if (msg.timestamp) {
      if (!turnStartTimestamp) turnStartTimestamp = msg.timestamp
      turnEndTimestamp = Math.max(turnEndTimestamp || 0, msg.completedAt ?? msg.timestamp)
    }

    if (msg.role === 'assistant') {
      sourceMessages.push(msg)
      turnErrorMessage = msg.stopReason === 'aborted' ? undefined : msg.errorMessage
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
          status: !msg.cancelled && typeof msg.exitCode === 'number' && msg.exitCode !== 0 ? 'error' : 'success',
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
                sourceEntry: toolRun?.sourceEntry,
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
                  id: `thinking-${msg.timestamp ?? i}-${pIdx}`,
                  type: 'thinking',
                  thinking: part.thinking,
                  status: msg === liveMessage && isAgentRunning && !completed[pIdx] ? 'running' : 'success',
                },
              })
            }
          } else if (part.type === 'text') {
            if (part.text) {
              turnItems.push({ kind: 'text', text: part.text, message: msg })
            }
          }
        }
      } else if (typeof msg.content === 'string') {
        if (msg.content) {
          turnItems.push({ kind: 'text', text: msg.content, message: msg })
        }
      }
    }
  }

  flushTurn(boundary?.last ?? true, boundary?.timestamp)
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

function assignedTools(messages: readonly PiMessage[]) {
  const assigned = new Set<string>()
  for (const message of messages) {
    if (!('content' in message) || !Array.isArray(message.content)) continue
    for (const part of message.content) if (part.type === 'toolCall' && part.id) assigned.add(part.id)
  }
  return assigned
}

type TurnPartition = {
  messages: PiMessage[]
  live: PiMessage | null
  dependencies: unknown[]
  running: boolean
  completed: Record<number, boolean>
  intervals: readonly PiRunInterval[]
  boundary?: number
  offset: number
  last: boolean
  turns: TurnChunk[]
}

/** 单条工具的迟到结果也能失效历史片段；关系依赖按原枚举顺序包含全部后代。 */
function toolDependencies(
  ids: Iterable<string>,
  tools: ChatState['tools'],
  unassigned: boolean,
  assigned: Set<string>,
) {
  const index = toolTreeIndex(tools)
  const dependencies: unknown[] = []
  const visit = (id: string, ancestors: Set<string>) => {
    if (ancestors.has(id)) return
    ancestors.add(id)
    for (const child of index.children.get(id) ?? []) {
      if (ancestors.has(child.id)) continue
      dependencies.push(child)
      visit(child.id, ancestors)
    }
    ancestors.delete(id)
  }
  for (const id of ids) {
    dependencies.push(tools[id])
    visit(id, new Set())
  }
  if (unassigned) {
    for (const tool of index.values) {
      if (tool.parentToolCallId || assigned.has(tool.id)) continue
      dependencies.push(tool)
      visit(tool.id, new Set())
    }
  }
  return dependencies
}

/** 有序消息按用户轮次失效；复杂时间线保留原分组并共享未变化的展示对象。 */
export function createConversationTurnProjector() {
  let partitions = new Map<number, TurnPartition>()
  let previous: TurnChunk[] = []
  let previousInputs: readonly unknown[] = []
  return (...args: Parameters<typeof groupConversationTurns>): TurnChunk[] => {
    const [
      messages,
      live,
      tools,
      running,
      completed = emptyCompleted,
      statuses = emptyStatuses,
      intervals = emptyIntervals,
      changes = emptyChanges,
      messageOffset = 0,
    ] = args
    const inputs = [messages, live, tools, running, completed, statuses, intervals, changes, messageOffset, args[9]]
    if (sameItems(previousInputs, inputs)) return previous
    const input = live ? [...messages, live] : messages
    let timestamp = -Infinity
    const compatible =
      !statuses.length &&
      !changes.length &&
      !args[9] &&
      (!live || !messages.includes(live)) &&
      input.every((message) => {
        if (
          !['user', 'assistant', 'toolResult', 'bashExecution'].includes(message.role) ||
          typeof message.timestamp !== 'number' ||
          !Number.isFinite(message.timestamp) ||
          message.timestamp < timestamp
        )
          return false
        timestamp = message.timestamp
        return true
      })
    if (!compatible) {
      partitions.clear()
      previous = retainTurns(previous, groupConversationTurns(...args))
      previousInputs = inputs
      return previous
    }

    const assigned = assignedTools(input)
    const starts = [0]
    for (let index = 1; index < input.length; index++) if (input[index]!.role === 'user') starts.push(index)
    const nextPartitions = new Map<number, TurnPartition>()
    const turns: TurnChunk[] = []
    for (let index = 0; index < starts.length; index++) {
      const from = starts[index]!
      const end = starts[index + 1] ?? input.length
      const last = index === starts.length - 1
      const boundary = last ? undefined : input[end]!.timestamp
      const slice = messages.slice(from, Math.min(end, messages.length))
      const active = last ? live : null
      const source = active ? [...slice, active] : slice
      const dependencies = toolDependencies(assignedTools(source), tools, last, assigned)
      const old = partitions.get(from)
      const completion = active ? completed : emptyCompleted
      const unchanged =
        old &&
        old.live === active &&
        old.running === running &&
        old.completed === completion &&
        old.intervals === intervals &&
        old.boundary === boundary &&
        old.offset === from + messageOffset &&
        old.last === last &&
        sameItems(old.messages, slice) &&
        sameItems(old.dependencies, dependencies)
      const grouped = unchanged
        ? old.turns
        : groupConversationTurns(
            slice,
            active,
            tools,
            running,
            completion,
            emptyStatuses,
            intervals,
            emptyChanges,
            from + messageOffset,
            { last, timestamp: boundary, assigned },
          )
      const partition = unchanged
        ? old
        : {
            messages: slice,
            live: active,
            dependencies,
            running,
            completed: completion,
            intervals,
            boundary,
            offset: from + messageOffset,
            last,
            turns: grouped,
          }
      nextPartitions.set(from, partition)
      turns.push(...partition.turns)
    }
    partitions = nextPartitions
    previous = retainTurns(previous, turns)
    const stable = new Map(previous.map((turn) => [turn.key, turn]))
    for (const partition of partitions.values()) {
      partition.turns = partition.turns.map((turn) => stable.get(turn.key) ?? turn)
    }
    previousInputs = inputs
    return previous
  }
}
