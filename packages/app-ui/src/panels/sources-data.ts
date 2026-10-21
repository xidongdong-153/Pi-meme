import type { ChatBranchAttachment } from '@pi-meme/contracts/chat-attachments'
import { messageAttachmentParts } from '@pi-meme/contracts/chat-attachments'
import type { QueuedInput } from '@pi-meme/contracts/plan'
import type { ComposerAttachment } from '@pi-meme/chat/ui/composer/image-attachment'
import type { PiImage } from '@pi-meme/contracts/pi'

export type SourceItem = {
  id: string
  name: string
  path?: string
  status: 'sent' | 'queued' | 'sending' | 'draft'
  statusText: string
  image?: PiImage
  preview?: File
}

const statusPriority: Record<SourceItem['status'], number> = {
  sent: 4,
  queued: 3,
  sending: 2,
  draft: 1,
}

export function collectSources({
  branchAttachments = [],
  steering = [],
  followUp = [],
  sending = [],
  draft = [],
  failed = [],
}: {
  branchAttachments?: readonly ChatBranchAttachment[]
  steering?: readonly QueuedInput[]
  followUp?: readonly QueuedInput[]
  sending?: readonly ComposerAttachment[]
  draft?: readonly ComposerAttachment[]
  failed?: readonly ComposerAttachment[]
}): SourceItem[] {
  const items: SourceItem[] = []

  // 1. Branch attachments (historical, sent)
  for (const att of branchAttachments) {
    items.push({
      id: att.id,
      name: att.name || '文件',
      path: att.path,
      image: att.image,
      status: 'sent',
      statusText: '已附加到对话',
    })
  }

  // 2. Queued inputs (steering & followUp)
  for (const input of [...steering, ...followUp]) {
    const { attachments: files } = messageAttachmentParts(input.text)
    for (let i = 0; i < files.length; i++) {
      items.push({
        id: `${input.id}:file:${i}`,
        name: files[i].name,
        path: files[i].path,
        status: 'queued',
        statusText: '排队中',
      })
    }
    for (let i = 0; i < (input.images?.length ?? 0); i++) {
      items.push({
        id: `${input.id}:image:${i}`,
        name: '图片',
        image: input.images![i],
        status: 'queued',
        statusText: '排队中',
      })
    }
  }

  // 3. Sending attachments
  for (const att of sending) {
    if (att.type === 'file') {
      items.push({
        id: att.id,
        name: att.name,
        path: att.path,
        preview: att.preview,
        status: 'sending',
        statusText: '发送中',
      })
    } else if (att.type === 'image') {
      items.push({
        id: att.id,
        name: att.name || '图片',
        image: { type: 'image', data: att.data, mimeType: att.mimeType },
        status: 'sending',
        statusText: '发送中',
      })
    }
  }

  // 4. Draft & failed drafts
  for (const att of [...draft, ...failed]) {
    if (att.type === 'file') {
      items.push({
        id: att.id,
        name: att.name,
        path: att.path,
        preview: att.preview,
        status: 'draft',
        statusText: '待发送',
      })
    } else if (att.type === 'image') {
      items.push({
        id: att.id,
        name: att.name || '图片',
        image: { type: 'image', data: att.data, mimeType: att.mimeType },
        status: 'draft',
        statusText: '待发送',
      })
    }
  }

  // Deduplicate preserving stable order
  const order: string[] = []
  const map = new Map<string, SourceItem>()

  for (const item of items) {
    const key = item.path
      ? `path:${item.path}`
      : item.image
        ? `img:${item.image.mimeType}:${item.image.data.slice(0, 80)}`
        : `id:${item.id}`

    const existing = map.get(key)
    if (!existing) {
      order.push(key)
      map.set(key, item)
    } else if (statusPriority[item.status] > statusPriority[existing.status]) {
      map.set(key, { ...item, id: existing.id })
    }
  }

  return order.map((key) => map.get(key)!)
}
