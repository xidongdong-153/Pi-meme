import type { ActivityItem, ToolRun, TurnChunk } from './types'

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
        ...(turn.sourceMessages ? { sourceMessages: retainItems(old.sourceMessages, turn.sourceMessages) } : {}),
        ...(turn.finalReplyMessages
          ? { finalReplyMessages: retainItems(old.finalReplyMessages, turn.finalReplyMessages) }
          : {}),
      }
      return sameFields(old, candidate) ? old : candidate
    }
    if (turn.type === 'agent_status' && old.type === 'agent_status') {
      const agents = turn.agents.map((agent, index) => {
        const previousAgent = old.agents[index]
        return previousAgent && sameFields(previousAgent, agent) ? previousAgent : agent
      })
      const candidate = { ...turn, agents: retainItems(old.agents, agents) }
      return sameFields(old, candidate) ? old : candidate
    }
    return sameFields(old, turn) ? old : turn
  })
  return retainItems(previous, turns)
}
