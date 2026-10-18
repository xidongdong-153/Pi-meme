import type { AgentSessionEvent, MessageUpdateEvent } from '@earendil-works/pi-coding-agent'
import type { PiEvent } from '@pi-meme/contracts/pi'

/** 桌面端消费的事件类型；turn_start 用于记录每次模型请求的起点。 */
const desktopEventTypes = new Set<PiEvent['type']>([
  'agent_start',
  'agent_end',
  'agent_settled',
  'turn_start',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'auto_retry_end',
  'summarization_retry_scheduled',
  'summarization_retry_attempt_start',
  'summarization_retry_finished',
])

/**
 * 把 SDK 会话事件转成桌面端使用的 JSON 形状，等价于 pi 包内部的 `toJsonEvent`：
 * 只有 `message_update` 需要改写，其余事件原样传递。
 */
export function toDesktopEvent(event: AgentSessionEvent): PiEvent | null {
  if (!desktopEventTypes.has(event.type as PiEvent['type'])) return null
  if (event.type !== 'message_update') return event as PiEvent
  if (event.message.role !== 'assistant') throw new Error('message_update 事件不是助手消息')
  return {
    type: 'message_update',
    usage: event.message.usage,
    assistantMessageEvent: toJsonAssistantMessageEvent(event.assistantMessageEvent),
  } as PiEvent
}

function toJsonAssistantMessageEvent(event: MessageUpdateEvent['assistantMessageEvent']) {
  if (event.type === 'toolcall_start') {
    const toolCall = event.partial.content[event.contentIndex]
    if (toolCall?.type !== 'toolCall') throw new Error(`toolcall_start 的 ${event.contentIndex} 不是工具调用`)
    const { partial: _partial, ...rest } = event
    return { ...rest, id: toolCall.id, toolName: toolCall.name }
  }
  if (!('partial' in event)) return event
  const { partial: _partial, ...rest } = event
  return rest
}
