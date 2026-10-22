import { resolveAgentTarget, type AgentSummary } from '@pi-meme/contracts/collaboration'
import type { PiMessage } from '@pi-meme/contracts/pi'
import { formatAgentName } from '@pi-meme/ui/lib/agent-name'
import { groupAdjacentActivities } from './activity-summary'
import { groupConversationTurns } from './conversation-turns'
import type { ActivityItem, AgentCollaborationStatus, ChatState, RenderSegment, TurnChunk } from './types'

type ToolResult = Extract<PiMessage, { role: 'toolResult' }>
type ToolActivity = Exclude<ActivityItem, { type: 'thinking' | 'narration' }>
type CollaborationSegment = { type: 'collaboration'; item: AgentCollaborationStatus }
type AgentName = Pick<AgentSummary, 'agentId' | 'taskPath' | 'name'>
type ToolRun = NonNullable<ToolActivity['children']>[number]

/** 子代理用来互相调度的工具。详情里不渲染调用行，只保留协作状态。 */
const agentOperationTools = new Set([
  'spawn_agent',
  'send_message',
  'followup_task',
  'interrupt_agent',
  'list_agents',
  'list_agent_models',
  'wait_agent',
  'finish_agent',
])

function isAgentOperation(item: ActivityItem): boolean {
  return item.type !== 'thinking' && item.type !== 'narration' && agentOperationTools.has(item.name ?? '')
}

function withoutAgentOperations(tools: ToolRun[] | undefined): ToolRun[] | undefined {
  if (!tools?.length) return tools
  let changed = false
  const next: ToolRun[] = []
  for (const tool of tools) {
    if (agentOperationTools.has(tool.name)) {
      changed = true
      continue
    }
    const children = withoutAgentOperations(tool.children)
    if (children !== tool.children) {
      changed = true
      next.push(children?.length ? { ...tool, children } : withoutChildren(tool))
      continue
    }
    next.push(tool)
  }
  return changed ? next : tools
}

function withoutChildren<T extends { children?: ToolRun[] }>(value: T): T {
  const copy = { ...value }
  delete copy.children
  return copy
}

function presentActivity(item: ActivityItem): ActivityItem {
  if (item.type === 'thinking' || item.type === 'narration' || !item.children?.length) return item
  const children = withoutAgentOperations(item.children)
  if (children === item.children) return item
  if (!children?.length) return withoutChildren(item)
  return { ...item, children }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function projectAgentConversation(chat: ChatState, agent: AgentSummary): TurnChunk[] {
  const messages = chat.messages.filter(
    (message) => message.role !== 'custom' || message.customType !== 'pi-meme-collaboration',
  )
  const turns = groupConversationTurns(
    messages,
    chat.live,
    chat.tools,
    chat.running,
    chat.stream.completed,
    [],
    chat.runIntervals,
  )
  const results = new Map<string, ToolResult>()
  const calledAt = new Map<string, number>()
  const identities = new Map<string, AgentName>()
  for (const message of chat.messages) {
    if (message.role !== 'toolResult') continue
    results.set(message.toolCallId, message)
    if (!['spawn_agent', 'followup_task', 'list_agents', 'wait_agent'].includes(message.toolName)) continue
    const details = object(message.details)
    const entries = Array.isArray(details.agents) ? [...details.agents] : []
    if (message.toolName === 'spawn_agent') entries.push(details)
    if (message.toolName === 'followup_task' && details.agent) entries.push(details.agent)
    for (const entry of entries) {
      const identity = object(entry)
      if (
        typeof identity.agentId === 'string' &&
        typeof identity.taskPath === 'string' &&
        typeof identity.name === 'string'
      )
        identities.set(identity.agentId, identity as AgentName)
    }
  }
  for (const identity of chat.agents ?? []) identities.set(identity.agentId, identity)
  identities.set(agent.agentId, agent)
  for (const message of [...messages, ...(chat.live ? [chat.live] : [])]) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) if (part.type === 'toolCall') calledAt.set(part.id, message.timestamp)
  }
  const resolve = (target: string) => resolveAgentTarget([...identities.values()], agent, target)
  const label = (id: string) =>
    id === agent.rootAgentId ? '主代理' : formatAgentName(identities.get(id)?.name ?? '其他代理')
  const names = (ids: string[]) => [...new Set(ids.map(label))].join('、') || '其他代理'
  const targetText = (ids: string[]) => {
    const text = names(ids)
    return /[a-z0-9]/i.test(text) ? ` ${text} ` : text
  }
  const runStartedAt = Date.parse(agent.runStartedAt ?? '')
  const current = (item: ToolActivity) =>
    chat.running &&
    ['starting', 'running', 'waiting_children', 'waiting_input'].includes(agent.status) &&
    (!Number.isFinite(runStartedAt) || (calledAt.get(item.id) ?? Infinity) >= runStartedAt)

  const statusFor = (item: ToolActivity) => {
    const result = results.get(item.id)
    const details = object(result?.details ?? object(item.result).details)
    const args = object(item.args)
    const targets =
      item.name === 'send_message'
        ? [args.target]
        : Array.isArray(args.targets)
          ? args.targets
          : [...identities.values()]
              .filter((identity) => identity.agentId !== agent.agentId)
              .map((identity) => identity.agentId)
    const ids = [
      ...new Set(
        targets.map((target) =>
          typeof target === 'string' ? (target === agent.rootAgentId ? target : (resolve(target)?.agentId ?? '')) : '',
        ),
      ),
    ]
    const targetNames = targetText(ids)
    const waiting = item.name === 'wait_agent'
    const failed = result?.isError ?? item.status === 'error'
    const pending = !result && !['success', 'error'].includes(chat.tools[item.id]?.status ?? '')
    const active = pending && current(item)
    const paused = agent.isPaused || chat.paused
    const row: AgentCollaborationStatus = {
      id: item.id,
      afterActivityId: item.id,
      kind: waiting ? 'wait' : 'feedback',
      status: 'inactive',
      text: '',
    }
    let retryable = false
    if (active) {
      row.status = paused ? 'inactive' : 'running'
      row.text = waiting
        ? `${paused ? '已暂停等待' : '正在等待'}${targetNames}的反馈…`
        : `${paused ? '已暂停向' : '正在向'}${targetNames}反馈…`
    } else if (failed || pending) {
      const interrupted = pending || ['interrupted', 'stopped'].includes(agent.status)
      row.status = interrupted ? 'inactive' : 'error'
      row.text = waiting
        ? `等待${targetNames}的反馈${interrupted ? '已中断' : '失败'}`
        : `向${targetNames}反馈${interrupted ? '已中断' : '失败'}`
    } else if (!waiting) {
      row.status = 'success'
      row.text = `已向${targetNames}反馈`
    } else {
      const feedback = Array.isArray(details.messages)
        ? details.messages.map(object).filter((message) => typeof message.fromAgentId === 'string')
        : []
      const senders = [
        ...feedback.map((message) => message.fromAgentId as string),
        ...(Array.isArray(details.notifiedBy)
          ? details.notifiedBy.filter((id): id is string => typeof id === 'string')
          : []),
      ]
      if (senders.length) {
        row.status = 'success'
        row.text = `已收到${targetText(senders)}的反馈`
      } else if (details.timedOut === true) {
        row.text = `尚未收到${targetNames}的反馈`
        retryable = true
      } else {
        const ended = Array.isArray(details.agents)
          ? details.agents
              .map(object)
              .filter(
                (identity) =>
                  ids.includes(String(identity.agentId)) &&
                  ['completed', 'failed', 'interrupted', 'stopped'].includes(String(identity.status)),
              )
          : []
        row.text = ended.length
          ? `${names(ended.map((identity) => String(identity.agentId)))} 已结束，等待结束`
          : `已结束等待${targetNames}的反馈`
      }
    }
    const signature = JSON.stringify(
      [
        ...new Set(targets.map((target) => (typeof target === 'string' ? (resolve(target)?.agentId ?? target) : ''))),
      ].sort(),
    )
    return { row, retryable, signature }
  }

  const projected = turns.map((turn) => {
    if (turn.type !== 'assistant_turn') return turn
    const collaboration: AgentCollaborationStatus[] = []
    let previousWait: { row: AgentCollaborationStatus; signature: string } | undefined
    for (const item of turn.activities) {
      if (item.type === 'thinking') continue
      if (item.type === 'narration' || (item.name !== 'wait_agent' && item.name !== 'send_message')) {
        previousWait = undefined
        continue
      }
      const { row, retryable, signature } = statusFor(item)
      if (item.name === 'wait_agent' && previousWait?.signature === signature) {
        const id = previousWait.row.id
        Object.assign(previousWait.row, row, { id })
      } else collaboration.push(row)
      previousWait = retryable ? { row: collaboration.at(-1)!, signature } : undefined
    }
    return collaboration.length ? { ...turn, collaboration } : turn
  })

  if (
    agent.status === 'completed' &&
    agent.runId &&
    agent.parentAgentId &&
    agent.report?.trim() &&
    agent.runCompletedAt
  ) {
    const completedAt = Date.parse(agent.runCompletedAt)
    let completedTool: { turn: Extract<TurnChunk, { type: 'assistant_turn' }>; id: string } | undefined
    for (const turn of projected) {
      if (turn.type !== 'assistant_turn') continue
      for (const item of turn.activities) {
        if (item.type === 'thinking' || item.type === 'narration' || item.name !== 'finish_agent') continue
        const result = results.get(item.id)
        const timestamp = calledAt.get(item.id) ?? NaN
        if (
          !result?.isError &&
          object(result?.details).accepted === true &&
          object(item.args).report === agent.report &&
          timestamp >= runStartedAt &&
          timestamp <= completedAt
        )
          completedTool = { turn, id: item.id }
      }
    }
    const reportMessage = messages.findLast(
      (message) =>
        message.role === 'assistant' &&
        message.timestamp >= runStartedAt &&
        message.timestamp <= completedAt &&
        message.content.some((part) => part.type === 'text' && part.text.trim()),
    )
    const reportTurn =
      completedTool?.turn ??
      (reportMessage
        ? projected.findLast(
            (turn) =>
              turn.type === 'assistant_turn' &&
              (turn.startedAt ?? 0) <= reportMessage.timestamp &&
              turn.finalText.endsWith(agent.report!.trim()),
          )
        : undefined)
    if (reportTurn?.type === 'assistant_turn') {
      const feedback: AgentCollaborationStatus = {
        id: `report-${agent.runId}`,
        kind: 'feedback',
        status: 'success',
        text: `已向${targetText([agent.parentAgentId])}反馈`,
        ...(completedTool ? { afterActivityId: completedTool.id } : {}),
      }
      const index = projected.indexOf(reportTurn)
      projected[index] = { ...reportTurn, collaboration: [...(reportTurn.collaboration ?? []), feedback] }
    }
  }
  return projected.map((turn) => (turn.type === 'assistant_turn' ? { ...turn, hideAgentOperations: true } : turn))
}

export function groupAgentActivities(
  items: ActivityItem[],
  finalText: string,
  collaboration: AgentCollaborationStatus[] = [],
  hideAgentOperations = false,
): Array<RenderSegment | CollaborationSegment> {
  const shown = (item: ActivityItem): ActivityItem | undefined => {
    if (!hideAgentOperations) return item
    if (isAgentOperation(item)) return undefined
    return presentActivity(item)
  }
  if (!collaboration.length) {
    if (!hideAgentOperations) return groupAdjacentActivities(items, finalText)
    return groupAdjacentActivities(
      items.flatMap((item) => {
        const next = shown(item)
        return next ? [next] : []
      }),
      finalText,
    )
  }
  const groups: Array<RenderSegment | CollaborationSegment> = []
  const anchors = new Map(
    collaboration.filter((item) => item.afterActivityId).map((item) => [item.afterActivityId, item]),
  )
  let pending: ActivityItem[] = []
  const flush = (text = '') => {
    if (pending.length || text) groups.push(...groupAdjacentActivities(pending, text))
    pending = []
  }
  for (const item of items) {
    const next = shown(item)
    if (next) pending.push(next)
    const status = anchors.get(item.id)
    if (!status) continue
    flush()
    groups.push({ type: 'collaboration', item: status })
  }
  const reports = collaboration.filter((item) => !item.afterActivityId)
  if (reports.length) {
    flush()
    groups.push(...reports.map((item) => ({ type: 'collaboration' as const, item })))
    flush(finalText)
  } else flush(finalText)
  return groups
}
