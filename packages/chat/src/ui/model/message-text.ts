import { browserAnnotationSummary } from '@pi-meme/contracts/browser-annotations'
import { skillMessageText } from '@pi-meme/contracts/skills'
import type { PiMessage } from '@pi-meme/contracts/pi'

export function messageText(message?: PiMessage | null): string {
  if (!message) return ''
  if (message.role === 'bashExecution') {
    if (!message.truncated) return message.output
    let note = '输出已截断'
    if (message.fullOutputPath) note += `，完整输出见 ${message.fullOutputPath}`
    else if (message.fullOutputError) note += `，完整输出保存失败：${message.fullOutputError}`
    return [message.output, note].filter(Boolean).join('\n\n')
  }
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
