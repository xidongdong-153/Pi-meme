import {
  explicitSessionName,
  sessionPreviewText,
  sessionTitleLimit,
  type PiSessionSummary,
} from '@pi-meme/contracts/sessions'

export function formatSessionTitle(session: PiSessionSummary, { full = false }: { full?: boolean } = {}): string {
  const preview = sessionPreviewText(session.firstMessage ?? '')
  const name = explicitSessionName(session.name, preview)
  if (name) return name
  if (preview) {
    const firstLine = preview.split('\n', 1)[0]
    return full ? firstLine : firstLine.slice(0, sessionTitleLimit)
  }
  return '新会话'
}
