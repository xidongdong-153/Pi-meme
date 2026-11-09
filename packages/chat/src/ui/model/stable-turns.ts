import type { ActivityItem, AgentCollaborationStatus, AgentStatusEvent, ToolRun, TurnChunk } from './types'

export function sameItems<T>(left: readonly T[], right: readonly T[]) {
  return left === right || (left.length === right.length && left.every((item, index) => item === right[index]))
}

function retainItems<T>(previous: T[] | undefined, next: T[]): T[] {
  return previous && sameItems(previous, next) ? previous : next
}

function sameFields<T extends object>(left: T, right: T) {
  const keys = Object.keys(right) as Array<keyof T>
  return (
    Object.keys(left).length === keys.length &&
    keys.every((key) => Object.hasOwn(left, key) && Object.is(left[key], right[key]))
  )
}

function byIdentity<T extends { id: string }>(items: readonly T[]) {
  const lookup = new Map<string, T[]>()
  for (const item of items) {
    const matches = lookup.get(item.id)
    if (matches) matches.push(item)
    else lookup.set(item.id, [item])
  }
  return new Map([...lookup].map(([id, matches]) => [id, matches.values()] as const))
}

function retainChildren(previous: ToolRun[] | undefined, next: ToolRun[] | undefined): ToolRun[] | undefined {
  if (!previous || !next || previous === next) return next
  const lookup = byIdentity(previous)
  const items = next.map((item) => {
    const old = lookup.get(item.id)?.next().value
    if (!old) return item
    const children = retainChildren(old.children, item.children)
    const candidate = children === item.children ? item : { ...item, children }
    return sameFields(old, candidate) ? old : candidate
  })
  return retainItems(previous, items)
}

function retainActivities(previous: ActivityItem[], next: ActivityItem[]) {
  if (previous === next) return next
  const lookup = byIdentity(previous)
  const items = next.map((item) => {
    const old = lookup.get(item.id)?.next().value
    if (!old || old.type !== item.type) return item
    let candidate = item
    if (item.type !== 'thinking' && item.type !== 'narration' && old.type !== 'thinking' && old.type !== 'narration') {
      const children = retainChildren(old.children, item.children)
      if (children !== item.children) candidate = { ...item, children }
    }
    return sameFields(old, candidate) ? old : candidate
  })
  return retainItems(previous, items)
}

function retainAgentStatus(previous: AgentStatusEvent, next: AgentStatusEvent): AgentStatusEvent {
  const agents = next.agents.map((agent, index) => {
    const old = previous.agents[index]
    return old && sameFields(old, agent) ? old : agent
  })
  const candidate = { ...next, agents: retainItems(previous.agents, agents) }
  return sameFields(previous, candidate) ? previous : candidate
}

function retainAgentStatuses(previous: AgentStatusEvent[] | undefined, next: AgentStatusEvent[]) {
  if (!previous || previous === next) return next
  const lookup = new Map(previous.map((item) => [item.key, item]))
  const statuses = next.map((item) => {
    const old = lookup.get(item.key)
    return old ? retainAgentStatus(old, item) : item
  })
  return retainItems(previous, statuses)
}

function retainTextParts(
  previous: AgentCollaborationStatus['textParts'],
  next: NonNullable<AgentCollaborationStatus['textParts']>,
) {
  if (!previous || previous === next) return next
  const parts = next.map((part, index) => {
    const old = previous[index]
    return typeof part !== 'string' && old && typeof old !== 'string' && sameFields(old, part) ? old : part
  })
  return retainItems(previous, parts)
}

function retainCollaboration(previous: AgentCollaborationStatus[] | undefined, next: AgentCollaborationStatus[]) {
  if (!previous || previous === next) return next
  const lookup = byIdentity(previous)
  return retainItems(
    previous,
    next.map((item) => {
      const old = lookup.get(item.id)?.next().value
      if (!old) return item
      const candidate = item.textParts ? { ...item, textParts: retainTextParts(old.textParts, item.textParts) } : item
      return sameFields(old, candidate) ? old : candidate
    }),
  )
}

/** 全量回退和增量路径共享同一个等价标准，不忽略来源、终态或后补字段。 */
export function retainTurns(previous: TurnChunk[], next: TurnChunk[]): TurnChunk[] {
  const lookup = new Map(previous.map((turn) => [turn.key, turn]))
  const turns = next.map((turn): TurnChunk => {
    const old = lookup.get(turn.key)
    if (!old || old === turn || old.type !== turn.type) return turn
    if (turn.type === 'assistant_turn' && old.type === 'assistant_turn') {
      const candidate = {
        ...turn,
        activities: retainActivities(old.activities, turn.activities),
        images: retainItems(old.images, turn.images),
        ...(turn.agentStatuses ? { agentStatuses: retainAgentStatuses(old.agentStatuses, turn.agentStatuses) } : {}),
        ...(turn.collaboration ? { collaboration: retainCollaboration(old.collaboration, turn.collaboration) } : {}),
        ...(turn.sourceMessages ? { sourceMessages: retainItems(old.sourceMessages, turn.sourceMessages) } : {}),
        ...(turn.finalReplyMessages
          ? { finalReplyMessages: retainItems(old.finalReplyMessages, turn.finalReplyMessages) }
          : {}),
      }
      return sameFields(old, candidate) ? old : candidate
    }
    if (turn.type === 'agent_status' && old.type === 'agent_status') return retainAgentStatus(old, turn)
    return sameFields(old, turn) ? old : turn
  })
  return retainItems(previous, turns)
}
