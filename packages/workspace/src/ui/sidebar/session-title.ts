import { browserAnnotationSummary } from '@pi-meme/contracts/browser-annotations'
import { skillMessageText } from '@pi-meme/contracts/skills'
import type { PiSessionSummary } from '@pi-meme/contracts/sessions'

export function formatSessionTitle(session: PiSessionSummary): string {
  if (session.name && session.name.trim()) return session.name.trim()
  if (session.firstMessage && session.firstMessage.trim()) {
    const firstLine = skillMessageText(browserAnnotationSummary(session.firstMessage)).trim().split('\n')[0]
    return firstLine.slice(0, 36)
  }
  return '新会话'
}
