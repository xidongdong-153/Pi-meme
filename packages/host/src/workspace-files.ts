import { constants } from 'node:fs'
import { open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { maxImagePreviewBytes } from '@pi-meme/contracts/app-host'
import type {
  FileContent,
  FileEntry,
  FilePreview,
  FileSearchResult,
  FileWriteInput,
  WorkspaceRef,
} from '@pi-meme/contracts/app-host'

export const maxFilePreviewBytes = 1024 * 1024
export type ResolveWorkspaceRoot = (ref: WorkspaceRef) => Promise<string>
const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
}
const revision = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function text(bytes: Buffer) {
  if (bytes.includes(0)) throw new Error('二进制文件不支持文本预览')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('文件不是有效的 UTF-8 文本')
  }
}
async function readBytes(filename: string, maximum: number) {
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('只能预览普通文件')
    if (info.size > maximum) return { info, bytes: null }
    const buffer = Buffer.alloc(maximum + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    return { info, bytes: offset > maximum ? null : buffer.subarray(0, offset) }
  } finally {
    await file.close()
  }
}

export async function previewLinkedFile(cwd: string, input: string): Promise<FilePreview> {
  if (typeof input !== 'string' || !input || input.includes('\0')) throw new Error('文件路径无效')
  const filename = await realpath(path.resolve(cwd, input))
  return readPreview(filename, input)
}

async function readPreview(filename: string, relativePath: string): Promise<FilePreview> {
  const mime = imageTypes[path.extname(filename).toLowerCase()]
  const { bytes } = await readBytes(filename, mime ? maxImagePreviewBytes : maxFilePreviewBytes)
  if (!bytes) return { kind: 'unsupported', relativePath, reason: 'too-large' }
  if (mime)
    return {
      kind: 'image',
      relativePath,
      dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
      size: bytes.length,
    }
  if (bytes.includes(0)) return { kind: 'unsupported', relativePath, reason: 'binary' }
  try {
    return { kind: 'text', relativePath, content: text(bytes), revision: revision(bytes) }
  } catch {
    return { kind: 'unsupported', relativePath, reason: 'encoding' }
  }
}

export function createWorkspaceFiles(
  resolveRoot: ResolveWorkspaceRoot,
  attachmentsRoot?: string | ((ref: WorkspaceRef) => string | string[] | Promise<string | string[]>),
) {
  const writes = new Map<string, Promise<unknown>>()
  const searches = new Map<
    string,
    { root: string; query: string; updated: number; iterator: AsyncGenerator<FileEntry> }
  >()
  async function target(ref: WorkspaceRef, relative: string) {
    if (
      typeof relative !== 'string' ||
      path.isAbsolute(relative) ||
      /[\\:\0]/.test(relative) ||
      relative.split('/').includes('..')
    )
      throw new Error('文件路径必须是工作目录内的相对路径')
    const root = await realpath(await resolveRoot(ref))
    const filename = await realpath(path.resolve(root, relative))
    if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) throw new Error('文件路径越出工作目录')
    return { root, filename }
  }
  async function attachmentTarget(ref: WorkspaceRef, absolute: string) {
    await resolveRoot(ref)
    const configuredRoots =
      typeof attachmentsRoot === 'function' ? await attachmentsRoot(ref) : attachmentsRoot ? [attachmentsRoot] : []
    const rootList = Array.isArray(configuredRoots) ? configuredRoots : [configuredRoots]
    const absoluteResolved = path.resolve(absolute)
    let matchedRoot: string | undefined
    for (const r of rootList) {
      if (!r) continue
      const resolvedR = path.resolve(r)
      const realR = await realpath(resolvedR).catch(() => '')
      if (realR && realR !== resolvedR) throw new Error('附件目录不能是符号链接')
      if (absoluteResolved.startsWith(`${resolvedR}${path.sep}`)) {
        matchedRoot = resolvedR
        break
      }
    }
    if (!matchedRoot) throw new Error('图片路径越出附件目录')
    const filename = await realpath(absolute)
    if (!filename.startsWith(`${matchedRoot}${path.sep}`)) throw new Error('图片路径越出附件目录')
    if (!imageTypes[path.extname(filename).toLowerCase()]) throw new Error('附件预览只支持图片')
    return { filename }
  }
  const api = {
    async list(ref: WorkspaceRef, relative = ''): Promise<FileEntry[]> {
      const { filename } = await target(ref, relative)
      const entries = await readdir(filename, { withFileTypes: true })
      if (entries.length > 10000) throw new Error('目录超过 10000 项，请选择更小的目录')
      const files = await Promise.all(
        entries.map(async (entry): Promise<FileEntry | null> => {
          const relativePath = path.posix.join(relative, entry.name)
          try {
            const { filename } = await target(ref, relativePath)
            const info = await stat(filename)
            if (!info.isDirectory() && !info.isFile()) return null
            return { name: entry.name, relativePath, kind: info.isDirectory() ? 'directory' : 'file', size: info.size }
          } catch {
            return null
          }
        }),
      )
      return files
        .filter((entry): entry is FileEntry => entry !== null)
        .sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
    },
    async read(ref: WorkspaceRef, relative: string): Promise<FileContent> {
      const { filename } = await target(ref, relative)
      const { bytes } = await readBytes(filename, maxFilePreviewBytes)
      if (!bytes) throw new Error('文件超过 1 MiB，无法预览')
      return { relativePath: relative, content: text(bytes) }
    },
    async preview(ref: WorkspaceRef, relative: string): Promise<FilePreview> {
      const { filename } =
        attachmentsRoot && typeof relative === 'string' && path.isAbsolute(relative)
          ? await attachmentTarget(ref, relative)
          : await target(ref, relative)
      return readPreview(filename, relative)
    },
    async write(ref: WorkspaceRef, input: FileWriteInput) {
      if (!input || typeof input.content !== 'string' || typeof input.revision !== 'string')
        throw new Error('文件保存参数无效')
      if (Buffer.byteLength(input.content, 'utf8') > maxFilePreviewBytes || input.content.includes('\0'))
        throw new Error('只能保存 1 MiB 以内的 UTF-8 文本')
      const { filename, root } = await target(ref, input.relativePath)
      const work = (writes.get(filename) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          const resolved = await target(ref, input.relativePath)
          if (resolved.filename !== filename || resolved.root !== root) throw new Error('文件路径已变化，请重新读取')
          const original = await readBytes(filename, maxFilePreviewBytes)
          if (!original.bytes) throw new Error('文件超过 1 MiB，无法保存')
          const content = text(original.bytes)
          if (revision(original.bytes) !== input.revision)
            throw new Error('文件已被其他程序修改，请重新读取；编辑内容仍保留')
          const normalized = input.content.replace(/\r\n/g, '\n')
          const crlf = content.includes('\r\n') && !content.replace(/\r\n/g, '').includes('\n')
          const next = Buffer.from(
            `${original.bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])) ? '\uFEFF' : ''}${crlf ? normalized.replace(/\n/g, '\r\n') : normalized}`,
            'utf8',
          )
          if (next.length > maxFilePreviewBytes) throw new Error('保存内容超过 1 MiB')
          if (next.equals(original.bytes)) return { revision: input.revision }
          const parent = path.dirname(filename)
          const temporary = path.join(parent, `.pi-meme-${randomUUID()}.tmp`)
          try {
            if ((await realpath(parent)) !== parent) throw new Error('文件目录已变化，请重新读取')
            const file = await open(temporary, 'wx', original.info.mode & 0o777)
            try {
              await file.chmod(original.info.mode & 0o777)
              await file.writeFile(next)
              await file.sync()
            } finally {
              await file.close()
            }
            const current = await target(ref, input.relativePath)
            if (current.filename !== filename || (await realpath(parent)) !== parent)
              throw new Error('文件路径已变化，请重新读取')
            const latest = await readBytes(filename, maxFilePreviewBytes)
            if (!latest.bytes || revision(latest.bytes) !== input.revision)
              throw new Error('文件已被其他程序修改，请重新读取；编辑内容仍保留')
            await rename(temporary, filename)
            return { revision: revision(next) }
          } finally {
            await rm(temporary, { force: true }).catch(() => {})
          }
        })
      writes.set(filename, work)
      try {
        return await work
      } finally {
        if (writes.get(filename) === work) writes.delete(filename)
      }
    },
    async search(ref: WorkspaceRef, input: { query: string; cursor?: string }): Promise<FileSearchResult> {
      if (!input || typeof input.query !== 'string' || !input.query.trim() || input.query.length > 200)
        throw new Error('搜索词必须是 1 到 200 个字符')
      const query = input.query.trim().toLowerCase()
      const { root } = await target(ref, '')
      const binding = JSON.stringify([
        ref.hostId,
        'sessionId' in ref ? ['session', ref.sessionId] : ['project', ref.projectId],
        root,
      ])
      for (const [id, value] of searches) if (Date.now() - value.updated > 60000) searches.delete(id)
      let cursor = input.cursor
      let search = cursor ? searches.get(cursor) : undefined
      if (cursor && (!search || search.root !== binding || search.query !== query))
        throw new Error('搜索已过期，请重新搜索')
      if (!search) {
        if (searches.size >= 16) searches.delete(searches.keys().next().value!)
        const scan = async function* (): AsyncGenerator<FileEntry> {
          const queue = ['']
          const visited = new Set<string>()
          while (queue.length) {
            const directory = queue.pop()!
            const { filename } = await target(ref, directory)
            if (visited.has(filename)) continue
            visited.add(filename)
            const entries = await api.list(ref, directory)
            for (const entry of entries) {
              if (entry.kind === 'directory') {
                if (!['.git', 'node_modules'].includes(entry.name)) queue.push(entry.relativePath)
              } else yield entry
            }
          }
        }
        cursor = randomUUID()
        search = { root: binding, query, updated: Date.now(), iterator: scan() }
        searches.set(cursor, search)
      }
      const entries: FileEntry[] = []
      for (let scanned = 0; scanned < 2000 && entries.length < 100; scanned++) {
        const next = await search.iterator.next()
        if (next.done) {
          searches.delete(cursor!)
          return { entries }
        }
        if (next.value.name.toLowerCase().includes(query)) entries.push(next.value)
      }
      search.updated = Date.now()
      return { entries, nextCursor: cursor }
    },
  }
  return api
}
