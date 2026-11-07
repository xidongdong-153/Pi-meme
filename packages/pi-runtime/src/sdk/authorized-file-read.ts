import path from 'node:path'
import type { ReadOperations } from '@earendil-works/pi-coding-agent'
import type { PiSdk } from './load'

/** Supplied by the Host after authorizing the canonical target, never by tool arguments. */
export type AuthorizedFileRead = {
  canonicalPath: string
  dev: string | number | bigint
  ino: string | number | bigint
}
export type AuthorizedFileReadBackend = (authorization: AuthorizedFileRead, signal?: AbortSignal) => Promise<Buffer>

function identity(value: AuthorizedFileRead['dev']): bigint {
  if (
    !['string', 'number', 'bigint'].includes(typeof value) ||
    (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) ||
    (typeof value === 'string' && !/^(?:0|[1-9]\d*)$/.test(value)) ||
    (typeof value === 'bigint' && value < 0n)
  )
    throw new Error('permission-denied: 文件授权对象身份无效')
  return BigInt(value)
}

function imageMimeType(buffer: Buffer): string | undefined {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff && buffer[3] !== 0xf7)
    return 'image/jpeg'
  if (buffer.length >= 16 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png'
  const signature = buffer.toString('ascii', 0, 6)
  if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp'
  if (buffer.length >= 26 && buffer.toString('ascii', 0, 2) === 'BM') return 'image/bmp'
  return undefined
}

/** The controlled backend opens one approved object; access, MIME and text share its bounded buffer. */
export function createAuthorizedReadOperations(
  authorization: AuthorizedFileRead,
  signal: AbortSignal | undefined,
  backend: AuthorizedFileReadBackend,
) {
  const canonicalPath = authorization.canonicalPath
  if (
    !path.isAbsolute(canonicalPath) ||
    canonicalPath.includes('\0') ||
    path.normalize(canonicalPath) !== canonicalPath
  )
    throw new Error('permission-denied: 文件授权必须使用规范绝对路径')
  const dev = identity(authorization.dev)
  const ino = identity(authorization.ino)
  if (ino === 0n) throw new Error('permission-denied: 文件系统未提供可核对的文件对象身份')
  if (typeof backend !== 'function') throw new Error('controlled-read-unavailable: 缺少受控文件读取后台')
  let contents: Promise<Buffer> | undefined
  let closed = false
  const read = (requestedPath: string) => {
    if (closed || requestedPath !== canonicalPath) throw new Error('permission-denied: 读取目标不匹配或授权已释放')
    signal?.throwIfAborted()
    return (contents ??= backend({ canonicalPath, dev, ino }, signal).then((bytes) => {
      signal?.throwIfAborted()
      if (!Buffer.isBuffer(bytes) || bytes.length > 64 * 1024 * 1024)
        throw new Error('permission-denied: 受控文件结果超过 64 MiB 或格式无效')
      return bytes
    }))
  }
  const operations: ReadOperations = {
    access: async (requestedPath) => {
      await read(requestedPath)
    },
    readFile: read,
    detectImageMimeType: async (requestedPath) => imageMimeType(await read(requestedPath)),
  }
  return {
    operations,
    close: async () => {
      closed = true
      await contents?.catch(() => {})
    },
  }
}

export function createAuthorizedReadToolDefinition(options: {
  sdk: Pick<PiSdk, 'createReadToolDefinition'>
  cwd: string
  approvals: Map<string, AuthorizedFileRead>
  read: AuthorizedFileReadBackend
}): ReturnType<PiSdk['createReadToolDefinition']> {
  const definition = options.sdk.createReadToolDefinition(options.cwd)
  return {
    ...definition,
    execute: async (callId, input, signal, onUpdate, context) => {
      const stored = options.approvals.get(callId)
      options.approvals.delete(callId)
      if (!stored) throw new Error('permission-denied: 文件读取缺少 Host 对本次调用的授权')
      const authorization = { ...stored }
      const approved = createAuthorizedReadOperations(authorization, signal, options.read)
      try {
        const tool = options.sdk.createReadToolDefinition(options.cwd, { operations: approved.operations })
        return await tool.execute(callId, { ...input, path: authorization.canonicalPath }, signal, onUpdate, context)
      } finally {
        await approved.close()
      }
    },
  }
}
