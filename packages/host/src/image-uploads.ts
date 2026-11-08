import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { maxImagePreviewBytes } from '@pi-meme/contracts/app-host'
import type { ImageLibraryStore } from '@pi-meme/image-generation/server/library-store'
import { storeChatAttachment } from './chat-attachments'

export class ImageUploadTooLargeError extends Error {
  constructor() {
    super('单张图片不能超过 8 MiB')
  }
}

/** 只清理本次上传创建的目录，重放回执与已有图片不受影响。 */
export async function storeImageUpload(
  root: string,
  library: ImageLibraryStore,
  metadata: { clientId: string; name: string; idempotencyKey: string },
  body: Readable,
  signal?: AbortSignal,
) {
  const { idempotencyKey } = metadata
  if (
    !idempotencyKey ||
    idempotencyKey.length > 128 ||
    Array.from(idempotencyKey).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error('图片上传幂等标识无效')
  signal?.throwIfAborted()
  const limited = Readable.from(
    (async function* () {
      let bytes = 0
      for await (const value of body) {
        signal?.throwIfAborted()
        const chunk = Buffer.from(value)
        bytes += chunk.byteLength
        if (bytes > maxImagePreviewBytes) throw new ImageUploadTooLargeError()
        yield chunk
      }
    })(),
  )
  const uploaded = await storeChatAttachment(root, metadata.name, limited, signal)
  try {
    signal?.throwIfAborted()
    const key = createHash('sha256')
      .update(JSON.stringify(['images.upload', metadata.clientId, idempotencyKey]))
      .digest('hex')
    const result = await library.importFile(uploaded.path, uploaded.name, key)
    if (!result.created) await rm(path.dirname(uploaded.path), { recursive: true, force: true })
    return result.item
  } catch (cause) {
    await rm(path.dirname(uploaded.path), { recursive: true, force: true })
    throw cause
  }
}
