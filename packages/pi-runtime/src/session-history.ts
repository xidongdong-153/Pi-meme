import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { SessionHistoryData, SessionWindow } from '@pi-meme/contracts/sessions'
import { projectSessionWindow } from '@pi-meme/contracts/session-window'
import { loadPiSdk, getPiVersion } from './sdk/load'
import { projectSessionHistory } from './history-projection'
import { readIndexedSessionHistory, invalidateHistoryIndex, prefetchHistoryIndex } from './session-history-index'

export type { SessionHistoryData } from '@pi-meme/contracts/sessions'

const cache = new Map<string, { mtime: number; ctime: number; size: number; data: SessionHistoryData }>()
const pending = new Map<string, Promise<SessionHistoryData>>()
const revisions = new Map<string, number>()
export function invalidateSessionHistory(paths: string[]) {
  for (const path of paths) {
    cache.delete(path)
    pending.delete(path)
    revisions.set(path, (revisions.get(path) ?? 0) + 1)
    invalidateHistoryIndex(path)
  }
}

export async function readSessionHistory(filePath: string, window?: SessionWindow): Promise<SessionHistoryData> {
  if (window) {
    projectSessionWindow({ messages: [] }, { ...window, before: undefined, from: undefined })
    return readIndexedSessionHistory(filePath, window, () => readSessionHistory(filePath))
  }
  const inFlight = pending.get(filePath)
  if (inFlight) return inFlight
  const revision = revisions.get(filePath) ?? 0
  const request = (async () => {
    const before = await stat(filePath)
    const cached = cache.get(filePath)
    if (cached && cached.mtime === before.mtimeMs && cached.ctime === before.ctimeMs && cached.size === before.size) {
      cache.delete(filePath)
      cache.set(filePath, cached)
      return cached.data
    }
    const { parseSessionEntries, migrateSessionEntries } = await loadPiSdk()
    const entries = parseSessionEntries(await readFile(filePath, 'utf8'))
    const header = entries.find((entry) => entry.type === 'session')
    if (!header?.cwd) throw new Error('会话文件缺少工作目录')
    // 只迁移内存副本，不使用会改写旧文件的 SessionManager.open。
    migrateSessionEntries(entries)
    const data = await projectSessionHistory(filePath, entries)
    const after = await stat(filePath)
    data.historyRevision = createHash('sha256')
      .update(`2:${getPiVersion()}:${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`)
      .digest('hex')
    data.historyDetails = 'complete'
    data.totalMessages = data.messages.length
    if (
      revision === (revisions.get(filePath) ?? 0) &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs &&
      before.size === after.size
    ) {
      cache.delete(filePath)
      if (cache.size >= 20) cache.delete(cache.keys().next().value!)
      cache.set(filePath, { mtime: before.mtimeMs, ctime: before.ctimeMs, size: before.size, data })
    }
    return data
  })()
  pending.set(filePath, request)
  try {
    return await request
  } finally {
    if (pending.get(filePath) === request) pending.delete(filePath)
  }
}

export async function prefetchSessionHistory(filePath: string): Promise<void> {
  try {
    await prefetchHistoryIndex(filePath)
  } catch {
    // 悬停预读失败时，点击会话仍会重新读取并显示错误。
  }
}
