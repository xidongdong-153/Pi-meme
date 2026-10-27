import type { DesktopEvent } from './desktop'

type Update = Extract<DesktopEvent['event'], { type: 'message_update' }>

export function mergeStreamUpdates(previous: DesktopEvent, next: DesktopEvent): DesktopEvent | undefined {
  if (previous.event.type !== 'message_update' || next.event.type !== 'message_update') return
  const left = previous.event.assistantMessageEvent
  const right = next.event.assistantMessageEvent
  if (
    !['text_delta', 'thinking_delta', 'toolcall_delta'].includes(left.type) ||
    left.type !== right.type ||
    !('delta' in left) ||
    !('delta' in right) ||
    !('contentIndex' in left) ||
    !('contentIndex' in right) ||
    left.contentIndex !== right.contentIndex ||
    previous.generation !== next.generation ||
    previous.executionGeneration !== next.executionGeneration ||
    previous.sessionKey !== next.sessionKey ||
    previous.runId !== next.runId ||
    previous.agentId !== next.agentId
  )
    return
  return {
    ...next,
    event: { ...next.event, assistantMessageEvent: { ...right, delta: left.delta + right.delta } } as Update,
  }
}
