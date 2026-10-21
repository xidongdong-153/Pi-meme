import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { ChatBranchAttachment } from '@pi-meme/contracts/chat-attachments'
import { messageAttachmentParts } from '@pi-meme/contracts/chat-attachments'
import type { PiImage } from '@pi-meme/contracts/pi'

export function projectBranchAttachments(
  entries: readonly SessionEntry[],
  leafId: string | null = entries.at(-1)?.id ?? null,
): ChatBranchAttachment[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const branch: SessionEntry[] = []
  let cursor = leafId ? byId.get(leafId) : undefined
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    branch.push(cursor)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  branch.reverse()

  const edits = new Map<string, SessionEntry>()
  for (const entry of branch) {
    if (entry.type === 'context_edit') {
      edits.set(entry.targetId, entry)
    }
  }

  const result: ChatBranchAttachment[] = []
  for (const entry of branch) {
    if (entry.type !== 'message' || entry.message.role !== 'user') continue
    const edit = edits.get(entry.id)
    if (edit && edit.type === 'context_edit' && edit.replacement === null) continue

    const replacement = edit && edit.type === 'context_edit' ? edit.replacement : undefined
    const content =
      replacement && typeof replacement === 'object' && 'content' in replacement
        ? replacement.content
        : entry.message.content

    let text = ''
    const images: PiImage[] = []
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue
        if ('type' in part) {
          if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
            text += part.text
          } else if (part.type === 'image' && 'data' in part && 'mimeType' in part) {
            images.push({
              type: 'image',
              data: String(part.data),
              mimeType: String(part.mimeType),
            })
          }
        }
      }
    }

    const { attachments: files } = messageAttachmentParts(text)
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      result.push({
        id: `${entry.id}:file:${i}`,
        entryId: entry.id,
        name: file.name,
        path: file.path,
      })
    }
    for (let i = 0; i < images.length; i++) {
      const image = images[i]
      result.push({
        id: `${entry.id}:image:${i}`,
        entryId: entry.id,
        name: '图片',
        image,
      })
    }
  }
  return result
}
