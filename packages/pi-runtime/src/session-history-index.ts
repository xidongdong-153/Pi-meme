import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { PiBranchEntry, PiMessage } from '@pi-meme/contracts/pi'
import type { SessionHistoryData, SessionWindow } from '@pi-meme/contracts/sessions'
import { projectSessionWindow, projectSessionDetails } from '@pi-meme/contracts/session-window'
import { loadPiSdk, getPiVersion } from './sdk/load'
import { projectStableMessageMetadata } from './sdk/message-projection'
import { projectSessionHistory, computeHistoryStats } from './history-projection'
import { projectBranchEntries } from './session-tree-entries'

type Location = { offset: number; length: number }
type Row = Location & {
  role: PiMessage['role']
  part: number
  edit?: Location
  metadata: Pick<PiMessage, 'sourceEntry' | 'source' | 'completedAt'>
}
type Index = {
  version: string
  signature: string
  fileSize: number
  tail: string
  appendSafe: boolean
  rows: Row[]
  entries: PiBranchEntry[]
  leafId: string | null
  summary: Omit<SessionHistoryData, 'messages' | 'sessionEntries' | 'branchAttachments'>
}
const cache = new Map<string, Index>()
const pending = new Map<string, Promise<Index | undefined>>()
const revisions = new Map<string, number>()
const committedAppends = new Set<string>()
type BuildJob = {
  file: string
  background: boolean
  run: () => Promise<Index | undefined>
  resolve: (value: Index | undefined) => void
  reject: (cause: unknown) => void
}
const builds: BuildJob[] = []
let building = false

function drain() {
  if (building) return
  const job = builds.shift()
  if (!job) return
  building = true
  void job
    .run()
    .then(job.resolve, job.reject)
    .finally(() => {
      building = false
      drain()
    })
}

function scheduleBuild(file: string, background: boolean, run: BuildJob['run']) {
  return new Promise<Index | undefined>((resolve, reject) => {
    if (background) {
      const obsolete = builds.findIndex((job) => job.background)
      if (obsolete >= 0) builds.splice(obsolete, 1)[0].resolve(undefined)
    }
    const job = { file, background, run, resolve, reject }
    if (background) builds.push(job)
    else {
      const firstBackground = builds.findIndex((entry) => entry.background)
      if (firstBackground < 0) builds.push(job)
      else builds.splice(firstBackground, 0, job)
    }
    drain()
  })
}

export function markHistoryAppend(file: string) {
  if (cache.has(file)) committedAppends.add(file)
}

export function invalidateHistoryIndex(file: string) {
  cache.delete(file)
  committedAppends.delete(file)
  revisions.set(file, (revisions.get(file) ?? 0) + 1)
}

function indexFile(file: string) {
  const marker = `${path.sep}data${path.sep}sessions${path.sep}`
  const start = file.lastIndexOf(marker)
  if (start < 0) return
  return path.join(
    file.slice(0, start),
    'cache/session-history',
    `${createHash('sha256').update(file).digest('hex')}.json`,
  )
}

export async function removeHistoryIndexes(files: string[]) {
  await Promise.all(
    files.map(async (file) => {
      invalidateHistoryIndex(file)
      const target = indexFile(file)
      if (target) await rm(target, { force: true }).catch(() => {})
    }),
  )
}

async function signature(file: string) {
  const value = await stat(file)
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`
}

function remember(file: string, value: Index) {
  cache.delete(file)
  cache.set(file, value)
  while (cache.size > 20) cache.delete(cache.keys().next().value!)
}

async function build(file: string, expected: string, version: string): Promise<Index | undefined> {
  const sdk = await loadPiSdk()
  const bytes = await readFile(file)
  const entries = sdk.parseSessionEntries(bytes.toString('utf8'))
  const header = entries.find((entry) => entry.type === 'session')
  if (header?.version !== sdk.CURRENT_SESSION_VERSION) return
  const locations: Location[] = []
  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(10, start)
    const end = newline < 0 ? bytes.length : newline
    if (bytes.subarray(start, end).toString('utf8').trim()) locations.push({ offset: start, length: end - start })
    start = end + 1
  }
  // 非完整行和旧条目交给 SDK 原有读取路径，不能猜测原生 ID 对应的文件位置。
  if (locations.length !== entries.length || entries.some((entry) => typeof entry.id !== 'string')) return
  const byId = new Map(entries.map((entry, index) => [entry.id, locations[index]]))
  const history = entries.filter((entry): entry is SessionEntry => entry.type !== 'session')
  const projection = sdk.buildSessionProjection(history)
  const messages = projectStableMessageMetadata(history, projection)
  const edits = new Map(
    projection.entries.flatMap(({ sourceEntry }) =>
      sourceEntry.type === 'context_edit' ? [[sourceEntry.targetId, byId.get(sourceEntry.id)!] as const] : [],
    ),
  )
  let position = 0
  const rows: Row[] = projection.entries.flatMap(({ sourceEntry, messages: projected }) =>
    projected.map((_, part) => {
      const message = messages[position++]
      return {
        ...byId.get(sourceEntry.id)!,
        part,
        role: message.role,
        edit: edits.get(sourceEntry.id),
        metadata: {
          ...(message.sourceEntry ? { sourceEntry: message.sourceEntry } : {}),
          ...(message.source ? { source: message.source } : {}),
          ...(message.completedAt !== undefined ? { completedAt: message.completedAt } : {}),
        },
      }
    }),
  )
  const data = await projectSessionHistory(file, entries)
  const { messages: _messages, sessionEntries, branchAttachments: _attachments, ...summary } = data
  if ((await signature(file)) !== expected) throw new Error('会话历史在建立索引期间已更新，请重试')
  return {
    version,
    signature: expected,
    rows,
    fileSize: bytes.length,
    tail: bytes.subarray(Math.max(0, bytes.length - 64)).toString('base64'),
    appendSafe: history.every(
      (entry, index) =>
        ['message', 'model_change', 'thinking_level_change', 'usage', 'session_info'].includes(entry.type) &&
        entry.parentId === (index ? history[index - 1].id : null),
    ),
    entries: (sessionEntries?.entries ?? []).map(({ preview: _preview, ...entry }) => entry),
    leafId: sessionEntries?.leafId ?? null,
    summary: { ...summary, totalMessages: rows.length },
  }
}

async function appendIndex(file: string, previous: Index, expected: string): Promise<Index | undefined> {
  if (!previous.appendSafe || !committedAppends.delete(file)) return
  const info = await stat(file)
  if (
    info.size <= previous.fileSize ||
    info.size - previous.fileSize > 32 * 1024 * 1024 ||
    expected.split(':').slice(0, 2).join(':') !== previous.signature.split(':').slice(0, 2).join(':')
  )
    return
  const handle = await open(file, 'r')
  const bytes = Buffer.alloc(info.size - previous.fileSize)
  try {
    const tail = Buffer.alloc(Math.min(64, previous.fileSize))
    await handle.read(tail, 0, tail.length, previous.fileSize - tail.length)
    if (tail.toString('base64') !== previous.tail) return
    if ((await handle.read(bytes, 0, bytes.length, previous.fileSize)).bytesRead !== bytes.length) return
  } finally {
    await handle.close()
  }
  const entries: SessionEntry[] = []
  const locations = new Map<string, Location>()
  let parent = previous.leafId
  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(10, start)
    const end = newline < 0 ? bytes.length : newline
    const text = bytes.subarray(start, end).toString('utf8').trim()
    if (text) {
      let entry: SessionEntry
      try {
        entry = JSON.parse(text) as SessionEntry
      } catch {
        return
      }
      if (
        !['message', 'model_change', 'thinking_level_change', 'usage', 'session_info'].includes(entry.type) ||
        !entry.id ||
        entry.parentId !== parent
      )
        return
      locations.set(entry.id, { offset: previous.fileSize + start, length: end - start })
      entries.push(entry)
      parent = entry.id
    }
    start = end + 1
  }
  if (!entries.length) return
  const sdk = await loadPiSdk()
  const projection = sdk.buildSessionProjection(entries)
  const messages = projectStableMessageMetadata(entries, projection)
  let position = 0
  const added = projection.entries.flatMap(({ sourceEntry, messages: projected }) =>
    projected.map((_, part): Row => {
      const message = messages[position++]
      return {
        ...locations.get(sourceEntry.id)!,
        part,
        role: message.role,
        metadata: {
          ...(message.sourceEntry ? { sourceEntry: message.sourceEntry } : {}),
          ...(message.source ? { source: message.source } : {}),
          ...(message.completedAt !== undefined ? { completedAt: message.completedAt } : {}),
        },
      }
    }),
  )
  const before = previous.summary.stats
  const stats = computeHistoryStats(entries, before?.sessionId ?? '', file)
  if (before) {
    for (const field of [
      'userMessages',
      'assistantMessages',
      'toolCalls',
      'toolResults',
      'totalMessages',
      'cost',
    ] as const)
      stats[field] += before[field]
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const)
      stats.tokens[field] += before.tokens[field]
    if (!stats.contextUsage?.tokens) stats.contextUsage = before.contextUsage
  }
  if ((await signature(file)) !== expected) throw new Error('会话历史已更新，请重新加载')
  return {
    ...previous,
    signature: expected,
    fileSize: info.size,
    tail: Buffer.concat([Buffer.from(previous.tail, 'base64'), bytes])
      .subarray(-64)
      .toString('base64'),
    rows: [...previous.rows, ...added],
    entries: [...previous.entries, ...projectBranchEntries(entries).map(({ preview: _preview, ...entry }) => entry)],
    leafId: parent,
    summary: {
      ...previous.summary,
      stats,
      totalMessages: previous.rows.length + added.length,
      model: projection.model
        ? { provider: projection.model.provider, id: projection.model.modelId }
        : previous.summary.model,
      thinkingLevel: entries.some((entry) => entry.type === 'thinking_level_change')
        ? (projection.thinkingLevel as SessionHistoryData['thinkingLevel'])
        : previous.summary.thinkingLevel,
      sessionName: entries.some((entry) => entry.type === 'session_info')
        ? entries.findLast((entry) => entry.type === 'session_info')?.name
        : previous.summary.sessionName,
    },
  }
}

async function readIndex(file: string, background = false): Promise<Index | undefined> {
  const target = indexFile(file)
  if (!target) return
  const expected = await signature(file)
  const version = `2:${getPiVersion()}`
  const retained = cache.get(file)
  if (retained?.signature === expected && retained.version === version) {
    remember(file, retained)
    return retained
  }
  const running = pending.get(file)
  if (running) {
    if (!background) {
      const queued = builds.findIndex((job) => job.file === file)
      if (queued >= 0) {
        const job = builds.splice(queued, 1)[0]
        job.background = false
        builds.unshift(job)
      }
    }
    return running
  }
  const revision = revisions.get(file) ?? 0
  const request = (async () => {
    if (!revisions.has(file)) {
      try {
        const saved = JSON.parse(await readFile(target, 'utf8')) as Index
        const validLocation = (location: Location) =>
          Number.isSafeInteger(location.offset) &&
          location.offset >= 0 &&
          Number.isSafeInteger(location.length) &&
          location.length > 0 &&
          location.offset + location.length <= saved.fileSize
        if (
          saved.version === version &&
          saved.signature === expected &&
          Number.isSafeInteger(saved.fileSize) &&
          saved.fileSize === Number(expected.split(':')[2]) &&
          Array.isArray(saved.rows) &&
          Array.isArray(saved.entries) &&
          saved.summary &&
          saved.rows.every(
            (row) =>
              validLocation(row) &&
              (!row.edit || validLocation(row.edit)) &&
              Number.isSafeInteger(row.part) &&
              row.part >= 0 &&
              row.metadata &&
              typeof row.role === 'string',
          )
        ) {
          remember(file, saved)
          return saved
        }
      } catch {
        /* 缓存缺失或损坏时从原生文件重建。 */
      }
    }
    const value = await scheduleBuild(file, background, async () => {
      const current = await signature(file)
      return (
        (retained?.version === version ? await appendIndex(file, retained, current) : undefined) ??
        (await build(file, current, version))
      )
    })
    if (!value || revision !== (revisions.get(file) ?? 0)) return
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
      if (revision !== (revisions.get(file) ?? 0) || (await signature(file)) !== value.signature) return
      await rename(temporary, target)
      if (
        revision !== (revisions.get(file) ?? 0) ||
        (await signature(file).catch(() => undefined)) !== value.signature
      ) {
        await rm(target, { force: true })
        return
      }
    } catch {
      // 缓存无法写入时仍可浏览原生会话。
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
    remember(file, value)
    return value
  })()
  pending.set(file, request)
  try {
    return await request
  } finally {
    if (pending.get(file) === request) pending.delete(file)
  }
}

export async function prefetchHistoryIndex(file: string) {
  await readIndex(await realpath(file), true)
}

function windowEntries(index: Index, messages: PiMessage[]) {
  const selected = new Set(messages.flatMap((message) => (message.sourceEntry ? [message.sourceEntry.id] : [])))
  const byId = new Map(index.entries.map((entry) => [entry.id, entry]))
  const branch: PiBranchEntry[] = []
  const seen = new Set<string>()
  let entry = index.leafId ? byId.get(index.leafId) : undefined
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id)
    if (selected.has(entry.id) || entry.type === 'model_change' || entry.id === index.leafId) branch.push(entry)
    entry = entry.parentId ? byId.get(entry.parentId) : undefined
  }
  const entries = branch
    .reverse()
    .map((entry, position, values) => ({ ...entry, parentId: position ? values[position - 1].id : null }))
  return { entries, leafId: entries.at(-1)?.id ?? null }
}

export async function readIndexedSessionHistory(
  original: string,
  window: SessionWindow,
  full: () => Promise<SessionHistoryData>,
): Promise<SessionHistoryData> {
  const file = await realpath(original)
  const index = await readIndex(file)
  if (!index) return projectSessionDetails(projectSessionWindow(await full(), window), window)
  const placeholders = index.rows.map((row) => ({ role: row.role, sourceEntry: row.metadata.sourceEntry }) as PiMessage)
  const selection = projectSessionWindow({ messages: placeholders }, window)
  const start = selection.messages.length ? placeholders.indexOf(selection.messages[0]) : 0
  const sdk = await loadPiSdk()
  const handle = await open(file, 'r')
  const loaded = new Map<number, SessionEntry>()
  const load = async (location: Location) => {
    const cached = loaded.get(location.offset)
    if (cached) return cached
    const bytes = Buffer.alloc(location.length)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, location.offset)
    if (bytesRead !== bytes.length) throw new Error('会话历史已更新，请重新加载')
    const value = JSON.parse(bytes.toString('utf8')) as SessionEntry
    loaded.set(location.offset, value)
    return value
  }
  try {
    const messages: PiMessage[] = []
    for (const row of index.rows.slice(start, start + selection.messages.length)) {
      const entry = await load(row)
      const edit = row.edit ? await load(row.edit) : undefined
      const projected = edit
        ? sdk.buildSessionProjection(
            [
              { ...entry, parentId: null },
              { ...edit, parentId: entry.id },
            ],
            edit.id,
          ).messages
        : sdk.sessionEntryToContextMessages(entry)
      const message = projected[row.part]
      if (!message) throw new Error('会话历史索引与原生消息不一致')
      messages.push({ ...message, ...row.metadata } as PiMessage)
    }
    if ((await signature(file)) !== index.signature) throw new Error('会话历史已更新，请重新加载')
    const revision = createHash('sha256').update(`${index.version}:${index.signature}`).digest('hex')
    if (window.details !== 'deferred')
      return {
        ...(await full()),
        messages,
        messagePage: selection.messagePage,
        historyRevision: revision,
        historyDetails: 'complete',
        totalMessages: index.rows.length,
      }
    return {
      ...index.summary,
      messages,
      messagePage: selection.messagePage,
      historyRevision: revision,
      historyDetails: 'deferred',
      sessionEntries: windowEntries(index, messages),
    }
  } catch (cause) {
    if (
      !(cause instanceof SyntaxError) &&
      !(cause instanceof Error && cause.message === '会话历史索引与原生消息不一致')
    )
      throw cause
    invalidateHistoryIndex(file)
    return projectSessionDetails(projectSessionWindow(await full(), window), window)
  } finally {
    await handle.close()
  }
}
