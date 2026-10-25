import { browserAnnotationSummary } from '@pi-meme/contracts/browser-annotations'
import { skillMessageText } from '@pi-meme/contracts/skills'
import type { PiMessage } from '@pi-meme/contracts/pi'

export function messageText(message?: PiMessage | null): string {
  if (!message) return ''
  if (message.role === 'bashExecution') return message.output
  if (!('content' in message)) return ''
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('')
  return message.role === 'user' ? skillMessageText(browserAnnotationSummary(text)) : text
}

export { sameMessage } from '@pi-meme/contracts/pi'
