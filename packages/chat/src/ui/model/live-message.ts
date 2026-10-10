import { parseStreamingJson } from '@earendil-works/pi-ai/utils/json-parse'
import type { PiContent, PiEvent, PiMessage } from '@pi-meme/contracts/pi'
import type { LiveStream } from './types'

type AssistantMessage = Extract<PiMessage, { role: 'assistant' }>
type MessageUpdate = Extract<PiEvent, { type: 'message_update' }>

export function updateLiveMessage(live: AssistantMessage, stream: LiveStream, event: MessageUpdate) {
  const update = event.assistantMessageEvent
  if (update.type === 'done' || update.type === 'error') {
    const message = update.type === 'done' ? update.message : update.error
    return {
      live: message,
      stream: { arguments: {}, completed: Object.fromEntries(message.content.map((_, index) => [index, true])) },
    }
  }
  if (update.type === 'start') return { live: { ...live, usage: event.usage }, stream }
  const index = update.contentIndex
  if (!Number.isInteger(index) || index < 0 || index > live.content.length) return { live, stream }
  const content = [...live.content]
  const part = content[index]
  const nextStream = { arguments: { ...stream.arguments }, completed: { ...stream.completed } }

  switch (update.type) {
    case 'text_start':
      content[index] = { type: 'text', text: '' }
      nextStream.completed[index] = false
      break
    case 'text_delta':
      if (part?.type !== 'text') return { live, stream }
      content[index] = { ...part, text: part.text + update.delta }
      break
    case 'text_end':
      if (part?.type !== 'text') return { live, stream }
      content[index] = { ...part, text: update.content }
      nextStream.completed[index] = true
      break
    case 'thinking_start':
      content[index] = { type: 'thinking', thinking: '' }
      nextStream.completed[index] = false
      break
    case 'thinking_delta':
      if (part?.type !== 'thinking') return { live, stream }
      content[index] = { ...part, thinking: part.thinking + update.delta }
      break
    case 'thinking_end':
      if (part?.type !== 'thinking') return { live, stream }
      content[index] = { ...part, thinking: update.content }
      nextStream.completed[index] = true
      break
    case 'toolcall_start':
      content[index] = { type: 'toolCall', id: update.id, name: update.toolName, arguments: {} }
      nextStream.arguments[index] = ''
      nextStream.completed[index] = false
      break
    case 'toolcall_delta': {
      if (part?.type !== 'toolCall') return { live, stream }
      const raw = (nextStream.arguments[index] ?? '') + update.delta
      nextStream.arguments[index] = raw
      const args = parseStreamingJson<Extract<PiContent, { type: 'toolCall' }>['arguments']>(raw)
      content[index] = { ...part, arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {} }
      break
    }
    case 'toolcall_end':
      content[index] = update.toolCall
      delete nextStream.arguments[index]
      nextStream.completed[index] = true
      break
  }
  return { live: { ...live, content, usage: event.usage }, stream: nextStream }
}
