import type { SessionEntry, SessionProjection } from '@earendil-works/pi-coding-agent'
import type { PiMessage } from '@pi-meme/contracts/pi'
import { createHash } from 'node:crypto'
import { projectMessageSources } from './ui-source'
import { loadPiSdk } from './load'

const revisions = new WeakMap<SessionEntry, { original: string; edited: Map<string, string> }>()
function contentHash(message: object) {
  const content = 'content' in message ? message.content : undefined
  const details = 'details' in message ? message.details : undefined
  return createHash('sha256')
    .update(JSON.stringify([content ?? [], details ?? null]))
    .digest('hex')
}

/** 未编辑条目不扫描正文；真正改写时才计算并缓存有效内容的 ETag。 */
export function stableMessageRevision(entry: SessionEntry, message: PiMessage, editId?: string): string {
  if (!editId) return entry.id
  let cached = revisions.get(entry)
  if (!cached) {
    const original =
      entry.type === 'custom_message'
        ? { content: entry.content, details: entry.details }
        : entry.type === 'message'
          ? entry.message
          : {}
    cached = { original: contentHash(original), edited: new Map() }
    revisions.set(entry, cached)
  }
  const previous = cached.edited.get(editId)
  if (previous) return previous
  const hash = contentHash(message)
  const revision = hash === cached.original ? entry.id : `${entry.id}:${hash}`
  cached.edited.set(editId, revision)
  while (cached.edited.size > 4) cached.edited.delete(cached.edited.keys().next().value!)
  return revision
}

/** 使用原生投影的来源条目，不以时间戳或展示顺序猜测消息身份。 */
export function projectStableMessageMetadata(
  entries: readonly SessionEntry[],
  projection: SessionProjection,
  leafId: string | null = entries.at(-1)?.id ?? null,
): PiMessage[] {
  const edits = new Map<string, string>()
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  let cursor = leafId ? byId.get(leafId) : undefined
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    if (cursor.type === 'context_edit' && !edits.has(cursor.targetId)) edits.set(cursor.targetId, cursor.id)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  const messages: PiMessage[] = projection.entries.flatMap(({ sourceEntry, messages }) => {
    const stable =
      sourceEntry.type === 'custom_message' ||
      (sourceEntry.type === 'message' && ['user', 'assistant', 'toolResult'].includes(sourceEntry.message.role))
    return messages.map((message) =>
      stable
        ? {
            ...message,
            sourceEntry: {
              id: sourceEntry.id,
              type: sourceEntry.type as 'message' | 'custom_message',
              revision: stableMessageRevision(sourceEntry, message, edits.get(sourceEntry.id)),
            },
          }
        : message,
    )
  })
  return projectMessageSources(entries, messages, leafId)
}

export async function projectStableMessages(
  entries: SessionEntry[],
  leafId: string | null = entries.at(-1)?.id ?? null,
): Promise<PiMessage[]> {
  const { buildSessionProjection } = await loadPiSdk()
  return projectStableMessageMetadata(entries, buildSessionProjection(entries, leafId), leafId)
}
