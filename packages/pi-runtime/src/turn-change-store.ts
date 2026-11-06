import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { TurnChanges, TurnChangeFile, TurnChangeSummary } from '@pi-meme/contracts/turn-changes'
import type { GitReviewFileContent } from '@pi-meme/contracts/git-review'
import { loadPiSdk } from './sdk/load'
import { generateFilePatch } from './file-patch'

export type FileChangeRecord = {
  sessionFile: string
  entryId: string
  cwd: string
  target: string
  before: string | null
  after: string
}

type SavedFile = { path: string; target: string; before: string | null; after: string }
type SavedTurn = { entryId: string; files: SavedFile[]; undone: boolean; undoUnavailable?: string; revision: string }
const pending = new Map<string, Promise<unknown>>()

// Host 与 Worker 各自持有缓存；磁盘版本是跨线程的一致性依据。
const cacheBudget = 64 * 1024 * 1024
const cache = new Map<string, { value: unknown; bytes: number }>()
let cacheBytes = 0
let patchComputations = 0
let recordReads = 0
export function turnChangeCacheStats() {
  return { bytes: cacheBytes, budget: cacheBudget, entries: cache.size, patchComputations, recordReads }
}
const fileKeys = new WeakMap<SavedFile, string>()
const reads = new Map<string, Promise<SavedTurn | undefined>>()
function cached<T>(key: string): T | undefined {
  const entry = cache.get(key)
  if (!entry) return
  cache.delete(key)
  cache.set(key, entry)
  return entry.value as T
}
function remember(key: string, value: unknown) {
  const old = cache.get(key)
  if (old) {
    cacheBytes -= old.bytes
    cache.delete(key)
  }
  const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value))
  if (bytes > cacheBudget) return
  while (cacheBytes + bytes > cacheBudget && cache.size) {
    const first = cache.keys().next().value!
    cacheBytes -= cache.get(first)!.bytes
    cache.delete(first)
  }
  cache.set(key, { value, bytes })
  cacheBytes += bytes
}
async function readCachedTurn(sessionFile: string, entryId: string) {
  const file = location(sessionFile, entryId)
  if (reads.has(file)) return reads.get(file)!
  const task = (async () => {
    try {
      const info = await stat(file)
      const version = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
      const previous = cached<{ version: string; turn: SavedTurn }>(file)
      if (previous?.version === version) return previous.turn
      const turn = await readTurn(sessionFile, entryId)
      // 原子 rename 保证内容完整；并发保存后下一次 stat 会看到新版本。
      if (turn) remember(file, { version, turn })
      return turn
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
      throw cause
    }
  })().finally(() => {
    reads.delete(file)
  })
  reads.set(file, task)
  return task
}
async function fileChanges(file: SavedFile): Promise<TurnChangeFile> {
  const key = fileKeys.get(file) ?? `patch:${createHash('sha256').update(JSON.stringify(file)).digest('hex')}`
  fileKeys.set(file, key)
  const previous = cached<TurnChangeFile>(key)
  if (previous) return previous
  const sdk = await loadPiSdk()
  // 同一轮的并发摘要/详情读取在 SDK 加载后再次检查缓存。
  const ready = cached<TurnChangeFile>(key)
  if (ready) return ready
  patchComputations++
  const before = Buffer.from(file.before ?? '', 'base64')
  const after = Buffer.from(file.after, 'base64')
  const patch =
    before.includes(0) || after.includes(0)
      ? '二进制文件，不提供文本预览。'
      : generateFilePatch(sdk, file.path, before.toString('utf8'), after.toString('utf8'))
  let insertions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) insertions++
    if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  const result = {
    path: file.path,
    patch,
    insertions,
    deletions,
    status: file.before === null ? 'A' : 'M',
    absolutePath: file.target,
  }
  remember(key, result)
  return result
}

function location(sessionFile: string, entryId: string) {
  if (!entryId || typeof entryId !== 'string' || entryId.length > 256) throw new Error('变更轮次无效')
  return path.join(`${sessionFile}.changes`, `${createHash('sha256').update(entryId).digest('hex')}.json`)
}

async function readTurn(sessionFile: string, entryId: string): Promise<SavedTurn | undefined> {
  try {
    recordReads++
    return JSON.parse(await readFile(location(sessionFile, entryId), 'utf8')) as SavedTurn
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
    throw cause
  }
}

async function saveTurn(sessionFile: string, turn: SavedTurn) {
  const file = location(sessionFile, turn.entryId)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  turn.revision = randomUUID()
  await writeFile(temporary, JSON.stringify(turn), { mode: 0o600 })
  await rename(temporary, file)
}

export async function recordFileChange(
  sessionFile: string,
  entryId: string,
  cwd: string,
  target: string,
  before: Buffer | null,
  after: Buffer,
) {
  const key = location(sessionFile, entryId)
  const operation = (pending.get(key) ?? Promise.resolve()).then(async () => {
    const turn: SavedTurn = (await readTurn(sessionFile, entryId)) ?? {
      entryId,
      files: [],
      undone: false,
      revision: '',
    }
    if (turn.undone) {
      turn.files = []
      turn.undone = false
      delete turn.undoUnavailable
    }
    const existing = turn.files.find((file) => file.target === target)
    if (existing) {
      if (existing.after !== (before?.toString('base64') ?? null))
        turn.undoUnavailable = `本轮期间文件被其他操作修改，无法整轮撤销：${existing.path}`
      existing.after = after.toString('base64')
    } else
      turn.files.push({
        path: path.relative(cwd, target) || path.basename(target),
        target,
        before: before?.toString('base64') ?? null,
        after: after.toString('base64'),
      })
    turn.undone = false
    await saveTurn(sessionFile, turn)
    return turn.revision
  })
  pending.set(key, operation)
  try {
    return await operation
  } finally {
    if (pending.get(key) === operation) pending.delete(key)
  }
}

export async function readTurnChanges(sessionFile: string, entryIds: string[]): Promise<TurnChanges[]> {
  const turns = await Promise.all(entryIds.map((id) => readCachedTurn(sessionFile, id)))
  const result: TurnChanges[] = []
  for (const turn of turns) {
    if (!turn) continue
    const files: TurnChangeFile[] = []
    for (const file of turn.files) {
      if (file.before === file.after) continue
      files.push({
        ...(await fileChanges(file)),
        canOpen: await lstat(file.target)
          .then((info) => info.isFile())
          .catch(() => false),
      })
    }
    result.push({
      entryId: turn.entryId,
      files,
      insertions: files.reduce((sum, file) => sum + file.insertions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      undone: turn.undone,
      revision: turn.revision,
      ...(turn.undoUnavailable ? { undoUnavailable: turn.undoUnavailable } : {}),
    })
  }
  return result
}

/** 当前分支的轮次存在性；不生成 patch，也不探测目标文件是否还存在。 */
export async function readTurnChangePresence(
  sessionFile: string,
  entryIds: readonly string[],
): Promise<{ hasChanges: boolean; entryId?: string; revision: string }> {
  let names: Set<string>
  try {
    names = new Set(await readdir(`${sessionFile}.changes`))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { hasChanges: false, revision: 'empty' }
    throw cause
  }
  for (let index = entryIds.length - 1; index >= 0; index--) {
    const entryId = entryIds[index]!
    if (!names.has(path.basename(location(sessionFile, entryId)))) continue
    const turn = await readCachedTurn(sessionFile, entryId)
    // 撤销后历史仍可查看；只排除本轮最终内容与初始内容完全相同的记录。
    if (turn?.files.some((file) => file.before !== file.after))
      return { hasChanges: true, entryId, revision: turn.revision }
  }
  return { hasChanges: false, revision: 'empty' }
}

export async function readTurnChangeSummaries(sessionFile: string, entryIds: string[]): Promise<TurnChangeSummary[]> {
  return (await readTurnChanges(sessionFile, entryIds)).map((turn) => ({
    ...turn,
    files: turn.files.map(({ patch: _patch, ...file }) => file),
  }))
}

export async function readTurnChangeFile(
  sessionFile: string,
  entryId: string,
  filePath: string,
): Promise<GitReviewFileContent> {
  if (typeof filePath !== 'string') throw new Error('文件路径无效')
  const turn = await readCachedTurn(sessionFile, entryId)
  const file = turn?.files.find((item) => item.path === filePath)
  if (!file) throw new Error('本轮未保存此文件的历史内容')
  const before = Buffer.from(file.before ?? '', 'base64')
  const after = Buffer.from(file.after, 'base64')
  if (before.includes(0) || after.includes(0)) return { patch: '', notice: '二进制文件，不提供文本预览。' }
  if (before.length > 200 * 1024 || after.length > 200 * 1024)
    return { patch: '', notice: '文件超过 200 KiB，未在面板中预览。' }
  return {
    patch: (await fileChanges(file)).patch,
    before: before.toString('utf8'),
    after: after.toString('utf8'),
  }
}

/** 先校验整轮，再恢复文件；出现写入失败时恢复已经处理的文件。 */
export async function undoTurnChanges(sessionFile: string, entryId: string, cwd: string, fullAccess: boolean) {
  const turn = await readTurn(sessionFile, entryId)
  if (!turn) throw new Error('没有可撤销的变更记录')
  if (turn.undone) return
  if (turn.undoUnavailable) throw new Error(turn.undoUnavailable)
  const root = await realpath(cwd)
  const files = turn.files.filter((file) => file.before !== file.after)
  for (const file of files) {
    const target = await realpath(file.target).catch(() => '')
    const relative = path.relative(root, target)
    if (target !== file.target || !(await lstat(file.target)).isFile())
      throw new Error(`文件路径已变化，未撤销：${file.path}`)
    if (!fullAccess && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)))
      throw new Error(`当前权限不允许撤销工作区外的文件：${file.path}`)
    if (!(await readFile(file.target)).equals(Buffer.from(file.after, 'base64')))
      throw new Error(`文件已有后续修改，未撤销：${file.path}`)
  }
  const restored: SavedFile[] = []
  try {
    for (const file of files) {
      if (file.before === null) await unlink(file.target)
      else await writeFile(file.target, Buffer.from(file.before, 'base64'))
      restored.push(file)
    }
    turn.undone = true
    await saveTurn(sessionFile, turn)
  } catch (cause) {
    const rollback = await Promise.allSettled(
      restored.map((file) => writeFile(file.target, Buffer.from(file.after, 'base64'))),
    )
    if (rollback.some((result) => result.status === 'rejected'))
      throw new Error('撤销未完成，部分文件恢复失败，请检查工作区')
    throw cause
  }
}
