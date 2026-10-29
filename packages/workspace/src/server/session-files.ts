import { lstat, readdir, realpath, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { readSessionCwd } from './session-reader'

export const normalizeCwd = (cwd: string) => realpath(cwd).catch(() => path.resolve(cwd))

export async function scanProjectSessions(root: string, cwd: string) {
  const paths: string[] = []
  const warnings: string[] = []
  const normalized = await normalizeCwd(cwd)
  let directories
  try {
    directories = await readdir(root, { withFileTypes: true })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { paths, warnings }
    throw cause
  }
  for (const directory of directories) {
    if (!directory.isDirectory()) continue
    const files = await readdir(path.join(root, directory.name), { withFileTypes: true })
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
      const target = path.join(root, directory.name, file.name)
      try {
        const headerCwd = await readSessionCwd(target)
        if (!headerCwd || !path.isAbsolute(headerCwd)) throw new Error('缺少有效的会话工作目录')
        if ((await normalizeCwd(headerCwd)) === normalized) paths.push(target)
      } catch (cause) {
        warnings.push(`保留无法确认归属的文件 ${target}：${String(cause)}`)
      }
    }
  }
  return { paths: paths.sort(), warnings }
}

export async function validateSessionFile(root: string, value: string) {
  const resolvedRoot = await realpath(root)
  const resolved = await realpath(value)
  const relative = path.relative(resolvedRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !resolved.endsWith('.jsonl'))
    throw new Error('会话文件不在允许的会话目录内')
  if (!(await lstat(value)).isFile()) throw new Error('会话路径必须是普通文件')
  return resolved
}

export async function deleteSessionFiles(root: string, paths: string[]) {
  const deletedPaths: string[] = []
  const errors: string[] = []
  for (const target of paths) {
    if (target.startsWith('runtime:')) {
      deletedPaths.push(target)
      continue
    }
    try {
      const resolved = await validateSessionFile(root, target)
      await rm(`${resolved}.changes`, { recursive: true, force: true })
      await unlink(target)
      deletedPaths.push(target)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') deletedPaths.push(target)
      else errors.push(`无法删除 ${target}：${String(cause)}`)
    }
  }
  return { deletedPaths, errors }
}
