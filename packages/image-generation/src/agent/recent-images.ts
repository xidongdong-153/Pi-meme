import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { messageAttachmentParts } from '@pi-meme/contracts/chat-attachments'
import type { ImageArtifact, ImageSource } from '@pi-meme/contracts/image-generation'

export function recentImageSources(entries: readonly SessionEntry[], count: number): ImageSource[] {
  const edits = new Map(
    entries.filter((entry) => entry.type === 'context_edit').map((entry) => [entry.targetId, entry.replacement]),
  )
  const sources: ImageSource[] = []
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    if (edits.has(entry.id) && edits.get(entry.id) === null) continue
    const message = edits.get(entry.id) ?? entry.message
    if (!message || typeof message !== 'object' || !('content' in message)) continue
    if (entry.message.role === 'toolResult' && entry.message.isError) continue
    const content = message.content
    const artifact =
      !edits.has(entry.id) && entry.message.role === 'toolResult' && entry.message.toolName === 'image_gen'
        ? (entry.message.details as { artifact?: ImageArtifact } | undefined)?.artifact
        : undefined
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      content.forEach((part, index) => {
        if (part.type === 'text') text += part.text
        if (part.type === 'image') {
          sources.push({
            entryId: entry.id,
            index,
            ...(artifact?.path ? { path: artifact.path } : { image: part }),
          })
        }
      })
    }
    if (entry.message.role === 'user') {
      for (const file of messageAttachmentParts(text).attachments) {
        if (/\.(?:png|jpe?g|webp)$/i.test(file.path)) sources.push({ entryId: entry.id, path: file.path })
      }
    }
  }
  if (sources.length < count) throw new Error(`当前会话分支只有 ${sources.length} 张可引用图片，需要 ${count} 张`)
  return sources.slice(-count)
}
