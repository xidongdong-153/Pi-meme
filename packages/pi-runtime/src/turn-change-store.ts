import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { TurnChanges } from '@pi-meme/contracts/turn-changes'
import { loadPiSdk } from './sdk/load'

type SavedFile = { path: string; target: string; before: string | null; after: string }
type SavedTurn = { entryId: string; files: SavedFile[]; undone: boolean; undoUnavailable?: string }
const pending = new Map<string, Promise<unknown>>()

function location(sessionFile: string, entryId: string) {
  if (!entryId || typeof entryId !== 'string' || entryId.length > 256) throw new Error('变更轮次无效')
  return path.join(`${sessionFile}.changes`, `${createHash('sha256').update(entryId).digest('hex')}.json`)
}

async function readTurn(sessionFile: string, entryId: string): Promise<SavedTurn | undefined> {
  try {
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
    const turn: SavedTurn = (await readTurn(sessionFile, entryId)) ?? { entryId, files: [], undone: false }
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
  })
  pending.set(key, operation)
  try {
    await operation
  } finally {
    if (pending.get(key) === operation) pending.delete(key)
  }
}

export async function readTurnChanges(sessionFile: string, entryIds: string[]): Promise<TurnChanges[]> {
  const sdk = await loadPiSdk()
  const turns = await Promise.all(entryIds.map((id) => readTurn(sessionFile, id)))
  return turns.flatMap((turn) => {
    if (!turn) return []
    const files = turn.files
      .filter((file) => file.before !== file.after)
      .map((file) => {
        const before = Buffer.from(file.before ?? '', 'base64')
        const after = Buffer.from(file.after, 'base64')
        const binary = before.includes(0) || after.includes(0)
        const patch = binary
          ? '二进制文件，不提供文本预览。'
          : sdk.generateUnifiedPatch(file.path, before.toString('utf8'), after.toString('utf8'))
        let insertions = 0
        let deletions = 0
        for (const line of patch.split('\n')) {
          if (line.startsWith('+') && !line.startsWith('+++')) insertions++
          if (line.startsWith('-') && !line.startsWith('---')) deletions++
        }
        return { path: file.path, patch, insertions, deletions }
      })
    return [
      {
        entryId: turn.entryId,
        files,
        insertions: files.reduce((sum, file) => sum + file.insertions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        undone: turn.undone,
        ...(turn.undoUnavailable ? { undoUnavailable: turn.undoUnavailable } : {}),
      },
    ]
  })
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
