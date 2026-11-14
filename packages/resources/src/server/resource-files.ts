import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

export const resourceSizeLimit = 32 * 1024 * 1024
export type ResourceFile = { path: string; content: Buffer; mode?: number }
export function safeRelative(value: string) {
  if (!value || value.includes('\\') || value.includes('\0') || path.isAbsolute(value) || /^[a-z]:/i.test(value)) {
    throw new Error('资源路径必须是包内相对路径')
  }
  const parts = value.split('/')
  if (parts.some((part) => part === '..' || part === '')) throw new Error('资源路径不能包含空目录或 ..')
  const relative = parts.filter((part) => part !== '.').join('/')
  if (!relative) throw new Error('资源路径必须指向包内文件')
  return relative
}
export async function readResourceFiles(directory: string): Promise<ResourceFile[]> {
  const files: ResourceFile[] = []
  const initial = await lstat(directory)
  if (initial.isSymbolicLink()) throw new Error('资源不允许软链接')
  const root = await realpath(directory)
  const resolved = await lstat(root)
  if (resolved.dev !== initial.dev || resolved.ino !== initial.ino) throw new Error('资源根目录在读取期间被替换')
  let size = 0
  let count = 0
  async function walk(current: string, relative: string, depth: number) {
    if (depth > 64 || ++count > 10000) throw new Error('资源目录层级或文件数超限')
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error('资源不允许软链接')
    const actual = await realpath(current)
    const fromRoot = path.relative(root, actual)
    if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot))
      throw new Error('资源文件超出资源目录')
    if (info.isDirectory()) {
      for (const entry of (await readdir(actual)).sort())
        await walk(path.join(actual, entry), relative ? `${relative}/${entry}` : entry, depth + 1)
    } else if (info.isFile()) {
      if (size + info.size > resourceSizeLimit) throw new Error('资源超过 32 MiB')
      const file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let content: Buffer
      try {
        const opened = await file.stat()
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino)
          throw new Error('资源文件在读取期间被替换')
        const available = resourceSizeLimit - size
        const chunks: Buffer[] = []
        let length = 0
        while (length <= available) {
          const chunk = Buffer.alloc(Math.min(64 * 1024, available + 1 - length))
          const { bytesRead } = await file.read(chunk, 0, chunk.length, length)
          if (!bytesRead) break
          length += bytesRead
          if (length > available) throw new Error('资源超过 32 MiB')
          chunks.push(chunk.subarray(0, bytesRead))
        }
        const after = await file.stat()
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || length !== opened.size)
          throw new Error('资源文件在读取期间变化')
        content = Buffer.concat(chunks, length)
      } finally {
        await file.close()
      }
      size += content.length
      files.push({ path: relative || path.basename(current), content, mode: info.mode & 0o777 })
    } else throw new Error('资源不允许特殊文件')
  }
  await walk(root, '', 0)
  return files
}
export function resourceRevision(files: ResourceFile[]) {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash
      .update(file.path)
      .update('\0')
      .update(String(file.mode ?? 0o644))
      .update('\0')
      .update(String(file.content.length))
      .update('\0')
      .update(file.content)
  }
  return hash.digest('hex')
}
export async function materializeResource(directory: string, files: ResourceFile[]) {
  const target = path.join(directory, resourceRevision(files))
  try {
    if ((await lstat(target)).isDirectory()) return target
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  await mkdir(directory, { recursive: true })
  const staging = path.join(directory, `.stage-${randomUUID()}`)
  await mkdir(staging)
  try {
    let size = 0
    const seen = new Set<string>()
    for (const file of files) {
      const relative = safeRelative(file.path)
      if (seen.has(relative)) throw new Error(`资源文件重复：${relative}`)
      seen.add(relative)
      size += file.content.length
      if (size > resourceSizeLimit) throw new Error('资源超过 32 MiB')
      const output = path.join(staging, relative)
      await mkdir(path.dirname(output), { recursive: true })
      await writeFile(output, file.content, { mode: file.mode ?? 0o644 })
      await chmod(output, file.mode ?? 0o644)
    }
    await rename(staging, target)
    return target
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
function crc32(buffer: Buffer) {
  let value = 0xffffffff
  for (const byte of buffer) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}
export function unzipResource(buffer: Buffer): ResourceFile[] {
  if (buffer.length > resourceSizeLimit) throw new Error('上传压缩包超过 32 MiB')
  let end = buffer.length - 22
  while (end >= Math.max(0, buffer.length - 65557) && buffer.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0 || buffer.readUInt32LE(end) !== 0x06054b50) throw new Error('无效 ZIP 文件')
  const count = buffer.readUInt16LE(end + 10)
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || count === 65535)
    throw new Error('不支持分卷或 ZIP64')
  let offset = buffer.readUInt32LE(end + 16)
  let size = 0
  const files: ResourceFile[] = []
  for (let index = 0; index < count; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 目录损坏')
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const checksum = buffer.readUInt32LE(offset + 16)
    const compressed = buffer.readUInt32LE(offset + 20)
    const expanded = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const mode = buffer.readUInt32LE(offset + 38) >>> 16
    const local = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength
    if (
      offset > buffer.length ||
      flags & 1 ||
      ((mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000 && (mode & 0xf000) !== 0x4000)
    )
      throw new Error('ZIP 不允许加密文件或软链接')
    if (name.endsWith('/')) {
      safeRelative(name.slice(0, -1))
      continue
    }
    safeRelative(name)
    size += expanded
    if (size > resourceSizeLimit) throw new Error('ZIP 解压内容超过 32 MiB')
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP 文件头损坏')
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    if (start + compressed > buffer.length) throw new Error('ZIP 文件内容不完整')
    const bytes = buffer.subarray(start, start + compressed)
    const content =
      method === 0
        ? bytes
        : method === 8
          ? inflateRawSync(bytes, { maxOutputLength: Math.max(1, expanded) })
          : undefined
    if (!content || content.length !== expanded || crc32(content) !== checksum)
      throw new Error('ZIP 压缩方法或文件长度不正确')
    files.push({ path: name, content, mode: mode ? mode & 0o777 : 0o644 })
  }
  return files
}
