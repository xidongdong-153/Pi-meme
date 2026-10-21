import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { type Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MAX_CHAT_ATTACHMENT_BYTES, type ChatUploadedFile } from '@pi-meme/contracts/chat-attachments'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'

export class ChatAttachmentTooLargeError extends Error {
  constructor() {
    super('单个上传文件不能超过 50 MB')
  }
}

/** 保留展示名，磁盘名称去掉目录、控制字符与平台保留字符。 */
function attachmentFilename(name: string) {
  const basename = path.posix.basename(name.replaceAll('\\', '/'))
  const safe = Array.from(basename)
    .slice(0, 60)
    .map((character) => (character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character))
    .join('')
    .replace(/[. ]+$/, '')
  return `file-${safe || 'attachment'}`
}

export async function storeChatAttachment(
  dataRoot: string,
  name: unknown,
  body: Readable,
  signal?: AbortSignal,
): Promise<ChatUploadedFile> {
  if (typeof name !== 'string' || !name.trim()) throw new Error('附件文件名无效')
  signal?.throwIfAborted()
  const root = path.join(await realpath(dataRoot), storageLayoutRelativePaths.attachmentsDirectory)
  await mkdir(root, { recursive: true, mode: 0o700 })
  if ((await realpath(root)) !== root) throw new Error('附件目录不能是符号链接')
  const directory = await mkdtemp(path.join(root, 'upload-'))
  const file = path.join(directory, attachmentFilename(name))
  try {
    let bytes = 0
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength
        callback(bytes > MAX_CHAT_ATTACHMENT_BYTES ? new ChatAttachmentTooLargeError() : null, chunk)
      },
    })
    await pipeline(body, limit, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal })
  } catch (cause) {
    await rm(directory, { recursive: true, force: true })
    throw cause
  }
  return { name, path: file }
}
