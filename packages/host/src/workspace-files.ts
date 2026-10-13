import { constants } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { FileContent, FileEntry, WorkspaceRef } from '@pi-meme/contracts/app-host'

export const maxFilePreviewBytes = 1024 * 1024
export type ResolveWorkspaceRoot = (ref: WorkspaceRef) => Promise<string>

export function createWorkspaceFiles(resolveRoot: ResolveWorkspaceRoot) {
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
  return {
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
      const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const info = await file.stat()
        if (!info.isFile()) throw new Error('只能预览普通文件')
        if (info.size > maxFilePreviewBytes) throw new Error('文件超过 1 MiB，无法预览')
        const buffer = Buffer.alloc(maxFilePreviewBytes + 1)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > maxFilePreviewBytes) throw new Error('文件超过 1 MiB，无法预览')
        const bytes = buffer.subarray(0, bytesRead)
        if (bytes.includes(0)) throw new Error('二进制文件不支持文本预览')
        let content: string
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch {
          throw new Error('文件不是有效的 UTF-8 文本')
        }
        return { relativePath: relative, content }
      } finally {
        await file.close()
      }
    },
  }
}
