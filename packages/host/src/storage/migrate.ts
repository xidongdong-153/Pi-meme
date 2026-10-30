import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, link, mkdir, open, readdir, readlink, realpath, rename, rm, statfs, symlink } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { StorageProgress } from '@pi-meme/contracts/storage'
import { runGit } from '@pi-meme/git/server/git-service'
import { lockDataRoot, relocatedMarker, storageOwnerFile } from '../data-root'
import { contains, digest, optionalStat, readJson, writeJson } from './files'
import { relocateStorage, type WorktreeRelocation } from './relocate'
import { assertStorageHostIdentity } from './host-identity'

type Entry = {
  relative: string
  kind: 'file' | 'directory' | 'link'
  mode: number
  bytes: number
  hash?: string
  link?: string
}
type Journal = {
  version: 1
  id: string
  source: string
  target: string
  hostId: string
  stage: 'copying' | 'copied' | 'relocated' | 'committed'
  entries: Entry[]
  worktrees?: WorktreeRelocation[]
  pathMappings?: Array<readonly [string, string]>
}
const excluded = new Set(['host.lock', relocatedMarker, storageOwnerFile])
async function inventory(root: string, relative = '', hashes = true): Promise<Entry[]> {
  const entries: Entry[] = []
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    if (!relative && excluded.has(name)) continue
    const item = path.join(relative, name)
    const file = path.join(root, item)
    const info = (await optionalStat(file))!
    if (info.isDirectory()) {
      entries.push({ relative: item, kind: 'directory', mode: info.mode & 0o777, bytes: 0 })
      entries.push(...(await inventory(root, item, hashes)))
    } else if (info.isFile())
      entries.push({
        relative: item,
        kind: 'file',
        mode: info.mode & 0o777,
        bytes: info.size,
        ...(hashes ? { hash: await digest(file) } : {}),
      })
    else if (info.isSymbolicLink())
      entries.push({ relative: item, kind: 'link', mode: info.mode & 0o777, bytes: 0, link: await readlink(file) })
    else throw new Error(`存储含有不能安全迁移的特殊文件：${file}`)
  }
  return entries
}
function assertSeparate(source: string, target: string, anchor: string) {
  if (contains(source, anchor) || contains(anchor, source))
    throw new Error('应用数据目录与桌面启动目录存在嵌套，不能迁移')
  for (const root of [source, anchor])
    if (contains(root, target) || contains(target, root))
      throw new Error('新目录必须与当前数据目录和桌面启动目录完全分离')
}
export async function previewMigration(source: string, target: string, anchor: string, retryId?: string) {
  if (!path.isAbsolute(target) || target.includes('\0')) throw new Error('请选择绝对路径文件夹')
  const info = await optionalStat(target)
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('请选择真实存在的文件夹，不支持符号链接')
  const [from, to, bootstrap] = await Promise.all([realpath(source), realpath(target), realpath(anchor)])
  assertSeparate(from, to, bootstrap)
  if (path.resolve(target) !== to) throw new Error('目标路径不能包含符号链接')
  const names = await readdir(to)
  if (names.length) {
    const journal = await readJson<Journal>(path.join(to, storageOwnerFile))
    if (!retryId || journal?.id !== retryId || journal.source !== from || journal.target !== to)
      throw new Error('请选择空文件夹；不会覆盖已有文件')
  }
  const probe = path.join(to, `.storage-${randomUUID()}.tmp`)
  const descriptor = await open(probe, 'wx', 0o600)
  await descriptor.close()
  await rm(probe)
  const entries = await inventory(from, '', false)
  const bytes = entries.reduce((total, entry) => total + entry.bytes, 0)
  const space = await statfs(to)
  const availableBytes = space.bavail * space.bsize
  if (availableBytes < bytes + 16 * 1024 * 1024) throw new Error('目标磁盘可用空间不足，需要完整副本及至少 16 MiB 余量')
  return { path: to, bytes, availableBytes }
}
function movedLink(entry: Entry, source: string, target: string) {
  const value = entry.link!
  const absolute = path.resolve(path.dirname(path.join(source, entry.relative)), value)
  const next = contains(source, absolute) ? path.join(target, path.relative(source, absolute)) : absolute
  return path.isAbsolute(value) ? next : path.relative(path.dirname(path.join(target, entry.relative)), next)
}
async function verifySource(journal: Journal) {
  const actual = await inventory(journal.source)
  if (JSON.stringify(actual) !== JSON.stringify(journal.entries))
    throw new Error('迁移来源已变化，未切换目录；请重新选择空文件夹')
}
async function repairWorktrees(worktrees: WorktreeRelocation[], source: string, targetRoot: string, rollback = false) {
  for (const entry of worktrees) {
    const target = rollback ? entry.from : entry.to
    const repository =
      rollback && contains(targetRoot, entry.repository)
        ? path.join(source, path.relative(targetRoot, entry.repository))
        : entry.repository
    await runGit(repository, ['worktree', 'repair', target])
    const root = (await runGit(target, ['rev-parse', '--show-toplevel'])).stdout.trim()
    if ((await realpath(root)) !== (await realpath(target))) throw new Error(`Worktree 修复验证失败：${target}`)
  }
}
export async function migrateStorage(input: {
  source: string
  target: string
  anchor: string
  id: string
  hostId: string
  progress: (value: StorageProgress) => void
  commit: () => Promise<void>
  isCommitted?: () => Promise<boolean>
}) {
  const { id, hostId, progress, commit } = input
  const source = await realpath(input.source)
  const target = await realpath(input.target)
  assertSeparate(source, target, await realpath(input.anchor))
  if (source !== path.resolve(input.source) || target !== path.resolve(input.target))
    throw new Error('存储目录身份发生变化')
  const releaseSource = await lockDataRoot(source)
  let releaseTarget: (() => Promise<void>) | undefined
  let committed = false
  let journal: Journal | undefined
  let markerOwned = false
  const marker = path.join(source, relocatedMarker)
  const journalFile = path.join(target, storageOwnerFile)
  try {
    await assertStorageHostIdentity(source, hostId)
    const previous = await readJson<{ id: string; target: string }>(marker)
    if (previous && (previous.id !== id || previous.target !== target)) throw new Error('来源目录已有其他维护任务')
    const saved = await readJson<Journal>(journalFile)
    if (saved) {
      if (
        saved.version !== 1 ||
        saved.id !== id ||
        saved.source !== source ||
        saved.target !== target ||
        saved.hostId !== hostId ||
        !['copying', 'copied', 'relocated', 'committed'].includes(saved.stage)
      )
        throw new Error('目标目录不属于本次迁移任务或任务状态无效')
      await verifySource(saved)
      if (saved.worktrees !== undefined) {
        const projects = await readJson<{ worktrees?: Array<{ checkoutRoot: string; sourceProjectCwd: string }> }>(
          path.join(source, 'projects.json'),
        )
        const recorded = projects?.worktrees ?? []
        if (!Array.isArray(saved.worktrees) || !Array.isArray(recorded)) throw new Error('迁移 Worktree 日志格式无效')
        for (const entry of saved.worktrees) {
          const original = recorded.find((item) => item.checkoutRoot === entry.from)
          const repository =
            original && contains(source, original.sourceProjectCwd)
              ? path.join(target, path.relative(source, original.sourceProjectCwd))
              : original?.sourceProjectCwd
          if (
            !original ||
            entry.to !== path.join(target, path.relative(source, original.checkoutRoot)) ||
            entry.repository !== repository
          )
            throw new Error('迁移 Worktree 日志与来源记录不匹配')
        }
      }
      journal = saved
    } else {
      if ((await readdir(target)).length) throw new Error('目标文件夹不为空，未覆盖任何文件')
      progress({ stage: 'scanning', completedBytes: 0, totalBytes: 0 })
      journal = { version: 1, id, hostId, source, target, stage: 'copying', entries: await inventory(source) }
      await writeJson(journalFile, journal)
    }
    releaseTarget = await lockDataRoot(target)
    await writeJson(marker, { version: 1, id, hostId, target, status: 'maintaining' })
    markerOwned = true
    const totalBytes = journal.entries.reduce((sum, entry) => sum + entry.bytes, 0)
    if (journal.stage === 'copying') {
      const allowed = new Set([...journal.entries.map((entry) => entry.relative), `.storage-copy-${id}`])
      for (const entry of await inventory(target))
        if (!allowed.has(entry.relative)) throw new Error(`目标含有本任务之外的文件：${entry.relative}`)
      const space = await statfs(target)
      let remainingBytes = 0
      for (const entry of journal.entries)
        if (entry.kind === 'file' && !(await optionalStat(path.join(target, entry.relative))))
          remainingBytes += entry.bytes
      if (space.bavail * space.bsize < remainingBytes + 16 * 1024 * 1024)
        throw new Error('目标磁盘可用空间不足，未切换目录')
      let completedBytes = 0
      for (const entry of journal.entries) {
        const from = path.join(source, entry.relative)
        const to = path.join(target, entry.relative)
        const parent = await realpath(path.dirname(to))
        if (parent !== path.dirname(to) || !contains(target, parent)) throw new Error(`目标目录被链接重定向：${to}`)
        const existing = await optionalStat(to)
        if (entry.kind === 'directory') {
          if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
            throw new Error(`目标目录被替换：${to}`)
          await mkdir(to, { recursive: true, mode: 0o700 })
        } else if (entry.kind === 'link') {
          const value = movedLink(entry, source, target)
          if (existing) {
            if (!existing.isSymbolicLink() || (await readlink(to)) !== value) throw new Error(`目标链接不匹配：${to}`)
          } else await symlink(value, to)
        } else {
          if (existing) {
            if (!existing.isFile() || existing.isSymbolicLink() || (await digest(to)) !== entry.hash)
              throw new Error(`目标文件已变化：${to}`)
          } else {
            // 任务独占的同盘临时文件，校验后使用硬链接发布，绝不覆盖目标文件。
            const temporary = path.join(target, `.storage-copy-${id}`)
            await rm(temporary, { force: true })
            try {
              await pipeline(createReadStream(from), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
              const descriptor = await open(temporary, 'r+')
              try {
                await descriptor.sync()
              } finally {
                await descriptor.close()
              }
              if ((await digest(temporary)) !== entry.hash) throw new Error(`来源文件在复制期间变化：${from}`)
              await link(temporary, to)
            } finally {
              await rm(temporary, { force: true })
            }
          }
          completedBytes += entry.bytes
        }
        progress({ stage: 'copying', completedBytes, totalBytes })
      }
      progress({ stage: 'verifying', completedBytes: 0, totalBytes })
      for (const entry of journal.entries) {
        if (entry.kind === 'file' && (await digest(path.join(target, entry.relative))) !== entry.hash)
          throw new Error(`复制校验失败：${entry.relative}`)
        if (
          entry.kind === 'link' &&
          (await readlink(path.join(target, entry.relative))) !== movedLink(entry, source, target)
        )
          throw new Error(`链接校验失败：${entry.relative}`)
      }
      await verifySource(journal)
      journal.stage = 'copied'
      await writeJson(journalFile, journal)
    }
    progress({ stage: 'relocating', completedBytes: totalBytes, totalBytes })
    const relocated = await relocateStorage(source, target)
    journal.worktrees = relocated.worktrees
    journal.pathMappings = relocated.pathMappings
    await writeJson(journalFile, journal)
    const copiedPath = (relative: string) => {
      const mapping = journal!.pathMappings?.find(([from]) => contains(from, relative))
      return path.join(target, mapping ? path.join(mapping[1], path.relative(mapping[0], relative)) : relative)
    }
    for (const entry of journal.entries.filter((item) => item.kind === 'link')) {
      const destination = copiedPath(entry.relative)
      const original = path.resolve(path.dirname(path.join(source, entry.relative)), entry.link!)
      const absolute = contains(source, original) ? copiedPath(path.relative(source, original)) : original
      const value = path.isAbsolute(entry.link!) ? absolute : path.relative(path.dirname(destination), absolute)
      const existing = await optionalStat(destination)
      if (!existing?.isSymbolicLink()) throw new Error(`迁移链接被替换：${destination}`)
      const current = await readlink(destination)
      if (current === value) continue
      if (current !== movedLink(entry, source, target)) throw new Error(`迁移链接已被修改：${destination}`)
      const temporary = path.join(path.dirname(destination), `.storage-${randomUUID()}.tmp`)
      try {
        await symlink(value, temporary)
        await rename(temporary, destination)
      } finally {
        await rm(temporary, { force: true })
      }
    }
    const allowed = new Set(journal.entries.map((entry) => path.relative(target, copiedPath(entry.relative))))
    allowed.add('resources/state.json')
    allowed.add('state/resources.json')
    for (const entry of await inventory(target, '', false)) {
      if (!allowed.has(entry.relative) && !/^\.storage-[\da-f-]+\.tmp$/i.test(path.basename(entry.relative)))
        throw new Error(`目标含有本任务之外的文件：${entry.relative}`)
    }
    await repairWorktrees(journal.worktrees, source, target)
    journal.stage = 'relocated'
    await writeJson(journalFile, journal)
    for (const entry of [...journal.entries].reverse()) {
      const destination = copiedPath(entry.relative)
      const info = await optionalStat(destination)
      if (info && !info.isSymbolicLink()) await chmod(destination, entry.mode)
    }
    await chmod(target, (await optionalStat(source))!.mode & 0o777)
    await assertStorageHostIdentity(target, hostId)
    await writeJson(marker, { version: 1, id, hostId, target, status: 'moved' })
    await commit()
    committed = true
    journal.stage = 'committed'
    await writeJson(journalFile, journal)
    progress({ stage: 'complete', completedBytes: totalBytes, totalBytes })
  } catch (cause) {
    committed ||= (await input.isCommitted?.()) ?? false
    if (!committed) {
      try {
        if (journal?.worktrees) await repairWorktrees(journal.worktrees, source, target, true)
        const current = await readJson<{ id: string }>(marker)
        if (current?.id === id && (markerOwned || journal)) await rm(marker)
      } catch (rollback) {
        throw new AggregateError([cause, rollback], '迁移失败且 Worktree 登记未完全恢复，请先重试维护，不要启动旧服务')
      }
    }
    throw cause
  } finally {
    await releaseTarget?.()
    await releaseSource()
  }
}
