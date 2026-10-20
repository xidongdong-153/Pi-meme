import type { PiMessage } from './pi'
import type { SessionRef } from './app-host'
import { skillMessageText } from './skills'
import type { UiJsonValue, UiMessage, UiMessageBody, UiMessageMetadata } from './plugin-ui-data'
import { freezeUiValue, messageRefKey } from './plugin-ui-data'

export function uiMessageMetadata(
  message: PiMessage,
  session: SessionRef,
  transientId?: string,
): UiMessageMetadata | null {
  if (message.role === 'custom' && !message.display) return null
  const role = message.role === 'toolResult' ? 'tool' : message.role
  if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'custom') return null
  const ref = message.sourceEntry ? { session: { ...session }, entryId: message.sourceEntry.id } : undefined
  if (!ref && !transientId) return null
  return freezeUiValue({
    id: ref ? messageRefKey(ref) : transientId!,
    ref,
    role,
    timestamp: message.timestamp,
    completedAt: message.completedAt,
    revision: message.sourceEntry?.revision ?? transientId!,
    state:
      message.role === 'assistant' && message.stopReason === 'aborted'
        ? 'aborted'
        : (message.role === 'assistant' && message.errorMessage) || (message.role === 'toolResult' && message.isError)
          ? 'error'
          : ref
            ? 'complete'
            : 'streaming',
    source: message.source ? { ...message.source } : undefined,
    toolName: message.role === 'toolResult' ? message.toolName : undefined,
    toolCallId: message.role === 'toolResult' ? message.toolCallId : undefined,
    customType: message.role === 'custom' ? message.customType : undefined,
  })
}

/** JSON 数据去掉图片二进制与不可序列化值，不把 Pi 消息对象作为公共契约。 */
export function uiJson(value: unknown, depth = 0, seen = new Set<object>()): UiJsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'object' || depth > 20 || seen.has(value)) return undefined
  seen.add(value)
  const result: UiJsonValue = Array.isArray(value)
    ? value.map((item) => uiJson(item, depth + 1, seen) ?? null)
    : Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== 'thinking' && !((value as { type?: unknown }).type === 'image' && key === 'data'))
          .flatMap(([key, item]) => {
            const json = uiJson(item, depth + 1, seen)
            return json === undefined ? [] : [[key, json]]
          }),
      )
  seen.delete(value)
  return result
}

export function uiMessageBody(message: PiMessage, metadata: UiMessageMetadata): UiMessageBody {
  const content = 'content' in message ? message.content : []
  const text =
    typeof content === 'string'
      ? content
      : content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('')
  const images = (Array.isArray(content) ? content : []).flatMap((part, index) =>
    part.type === 'image'
      ? [{ index, mimeType: part.mimeType, ref: metadata.ref ? { message: metadata.ref, index } : undefined }]
      : [],
  )
  return freezeUiValue({
    text: message.role === 'user' ? skillMessageText(text) : text,
    images,
    data: 'details' in message ? uiJson(message.details) : undefined,
  })
}

export function projectUiMessage(message: PiMessage, session: SessionRef, transientId?: string): UiMessage | null {
  const metadata = uiMessageMetadata(message, session, transientId)
  return metadata ? freezeUiValue({ ...metadata, ...uiMessageBody(message, metadata) }) : null
}
