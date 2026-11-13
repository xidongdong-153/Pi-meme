import { resolveAgentTarget, type AgentSummary } from '@pi-meme/contracts/collaboration'
import type { PiMessage } from '@pi-meme/contracts/pi'
import { formatAgentName } from '@pi-meme/ui/lib/agent-name'
import { groupAdjacentActivities } from './activity-summary'
import { groupConversationTurns } from './conversation-turns'
import { isAgentInteraction, type AgentOperationItem } from './agent-operations'
import { extractImages, parseToolMeta } from './tool-details'
import { modelChangesForConversation } from './model-changes'
import type {
  ActivityItem,
  AgentCollaborationStatus,
  AgentStatusEvent,
  ChatState,
  RenderSegment,
  TurnChunk,
} from './types'

type ToolResult = Extract<PiMessage, { role: 'toolResult' }>
type ToolActivity = Exclude<ActivityItem, { type: 'thinking' | 'narration' }>
type CollaborationSegment = { type: 'collaboration'; item: AgentCollaborationStatus }
export type AgentActivitySegment =
  | RenderSegment
  | CollaborationSegment
  | { type: 'agent_status'; item: AgentStatusEvent }
  | { type: 'agent_operation'; item: AgentOperationItem }
  | { type: 'question'; item: ToolActivity }
  | { type: 'image_activity'; item: ToolActivity }
type AgentName = Pick<AgentSummary, 'agentId' | 'taskPath' | 'name'>
type ToolRun = NonNullable<ToolActivity['children']>[number]

/** 协作工具以专用操作与状态行呈现，不再重复渲染原始调用行。 */
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

function isQuestion(item: ActivityItem): item is ToolActivity & { name: 'request_user_input' } {
  return item.type !== 'thinking' && item.type !== 'narration' && item.name === 'request_user_input'
}

function isImageActivity(item: ActivityItem): boolean {
  return item.type !== 'thinking' && item.type !== 'narration' && parseToolMeta(item).kind === 'image'
}

function withoutAgentOperations(
  tools: ToolRun[] | undefined,
  hideAgentOperations: boolean,
  extractImageChildren: boolean,
): ToolRun[] | undefined {
  if (!tools?.length) return tools
  let changed = false
  const next: ToolRun[] = []
  for (const tool of tools) {
    if (
      isAgentInteraction(tool) ||
      isQuestion(tool) ||
      (hideAgentOperations && agentOperationTools.has(tool.name)) ||
      (extractImageChildren && isImageActivity(tool))
    ) {
      changed = true
      continue
    }
    const children = withoutAgentOperations(tool.children, hideAgentOperations, extractImageChildren)
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

function presentActivity(item: ActivityItem, hideAgentOperations: boolean): ActivityItem {
  if (item.type === 'thinking' || item.type === 'narration' || !item.children?.length) return item
  const children = withoutAgentOperations(item.children, hideAgentOperations, extractImages(item.result).length === 0)
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
    modelChangesForConversation(chat.sessionEntries, messages),
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
  const clickableIds = new Set(
    (chat.agents ?? [])
      .filter(
        (identity) =>
          identity.parentAgentId &&
          identity.rootSessionKey === agent.rootSessionKey &&
          identity.agentId !== agent.rootAgentId,
      )
      .map((identity) => identity.agentId),
  )
  type TextPart = NonNullable<AgentCollaborationStatus['textParts']>[number]
  const partText = (part: TextPart) => (typeof part === 'string' ? part : part.text)
  const targetParts = (ids: string[], padded: boolean): TextPart[] => {
    const parts: TextPart[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      const identity = identities.get(id)
      const text = id === agent.rootAgentId ? '主代理' : formatAgentName(identity?.name ?? '其他代理')
      // 姓名可以重复，去重依据是身份；没有稳定身份的通用占位只保留一次。
      const key = identity || id === agent.rootAgentId ? id : 'unknown'
      if (seen.has(key)) continue
      seen.add(key)
      if (parts.length) parts.push('、')
      parts.push(identity && clickableIds.has(id) ? { agentId: id, text } : text)
    }
    if (!parts.length) parts.push('其他代理')
    return padded && /[a-z0-9]/i.test(parts.map(partText).join('')) ? [' ', ...parts, ' '] : parts
  }
  const statusText = (
    prefix: string,
    ids: string[],
    suffix: string,
    padded = true,
  ): Pick<AgentCollaborationStatus, 'text' | 'textParts'> => {
    const textParts: TextPart[] = [prefix, ...targetParts(ids, padded), suffix]
    return { text: textParts.map(partText).join(''), textParts }
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
      Object.assign(
        row,
        statusText(
          waiting ? (paused ? '已暂停等待' : '正在等待') : paused ? '已暂停向' : '正在向',
          ids,
          waiting ? '的反馈…' : '反馈…',
        ),
      )
    } else if (failed || pending) {
      const interrupted = pending || ['interrupted', 'stopped'].includes(agent.status)
      row.status = interrupted ? 'inactive' : 'error'
      Object.assign(
        row,
        statusText(waiting ? '等待' : '向', ids, `${waiting ? '的反馈' : '反馈'}${interrupted ? '已中断' : '失败'}`),
      )
    } else if (!waiting) {
      row.status = 'success'
      Object.assign(row, statusText('已向', ids, '反馈'))
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
        Object.assign(row, statusText('已收到', senders, '的反馈'))
      } else if (details.timedOut === true) {
        Object.assign(row, statusText('尚未收到', ids, '的反馈'))
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
        Object.assign(
          row,
          ended.length
            ? statusText(
                '',
                ended.map((identity) => String(identity.agentId)),
                ' 已结束，等待结束',
                false,
              )
            : statusText('已结束等待', ids, '的反馈'),
        )
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
      if (item.type === 'narration' || item.name !== 'wait_agent') {
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
        ...statusText('已向', [agent.parentAgentId], '反馈'),
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
  agentStatuses: AgentStatusEvent[] = [],
): AgentActivitySegment[] {
  const shown = (item: ActivityItem): ActivityItem | undefined => {
    if (hideAgentOperations && isAgentOperation(item)) return undefined
    return presentActivity(item, hideAgentOperations)
  }
  const groups: AgentActivitySegment[] = []
  const anchors = new Map<string, AgentActivitySegment[]>()
  const addAnchor = (id: string, segment: AgentActivitySegment) => {
    const entries = anchors.get(id)
    if (entries) entries.push(segment)
    else anchors.set(id, [segment])
  }
  const reports: CollaborationSegment[] = []
  for (const item of collaboration) {
    const segment: CollaborationSegment = { type: 'collaboration', item }
    if (item.afterActivityId) addAnchor(item.afterActivityId, segment)
    else reports.push(segment)
  }
  const textStatuses: AgentStatusEvent[] = []
  for (const item of agentStatuses) {
    const segment: AgentActivitySegment = { type: 'agent_status', item }
    if (item.afterFinalTextLength !== undefined) textStatuses.push(item)
    else if (item.afterActivityId) addAnchor(item.afterActivityId, segment)
    else groups.push(segment)
  }
  let pending: ActivityItem[] = []
  const flush = () => {
    if (pending.length) groups.push(...groupAdjacentActivities(pending))
    pending = []
  }
  const append = (item: ActivityItem) => {
    const segment: AgentActivitySegment | undefined = isAgentInteraction(item)
      ? { type: 'agent_operation', item }
      : isQuestion(item)
        ? { type: 'question', item }
        : isImageActivity(item)
          ? { type: 'image_activity', item: presentActivity(item, hideAgentOperations) as ToolActivity }
          : undefined
    if (segment) {
      flush()
      groups.push(segment)
    } else {
      const next = shown(item)
      if (next) pending.push(next)
    }
  }
  const appendChildren = (item: ActivityItem, includeImages: boolean) => {
    if (item.type === 'thinking' || item.type === 'narration') return
    for (const child of item.children ?? []) {
      if (isAgentInteraction(child) || isQuestion(child) || (includeImages && isImageActivity(child))) append(child)
      appendChildren(child, includeImages && extractImages(child.result).length === 0)
    }
  }
  for (const item of items) {
    append(item)
    if (item.type !== 'thinking' && item.type !== 'narration')
      appendChildren(item, extractImages(item.result).length === 0)
    const statuses = anchors.get(item.id)
    if (!statuses) continue
    flush()
    groups.push(...statuses)
    anchors.delete(item.id)
  }
  flush()
  // 无锚点的报告属于过程末尾；找不到的旧锚点同样保留，不能静默丢失事件。
  groups.push(...[...anchors.values()].flat(), ...reports)
  // 最终回复保持完整 Markdown：消息之间也可能延续代码块、列表或引用。
  // 正文内部发生的事件保留原时间与锚点，但统一在完整正文之后呈现。
  for (const item of textStatuses) if (item.afterFinalTextLength! <= 0) groups.push({ type: 'agent_status', item })
  if (finalText.trim()) groups.push({ type: 'text', text: finalText, finalReply: true })
  for (const item of textStatuses) if (item.afterFinalTextLength! > 0) groups.push({ type: 'agent_status', item })
  return groups
}
