import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { PiSessionsSnapshot, PiSessionSummary } from '@pi-meme/contracts/sessions'
import { readSessionSummaryIndex, type SessionSummaryIndex } from './session-reader'
import { groupSessions } from './session-groups'

type CachedFile = {
  mtime: number
  ctime: number
  size: number
  ino: number
  dev: number
  summary: PiSessionSummary | null
  index: SessionSummaryIndex
}
type SerializedCache = { version: 5; files: [string, CachedFile][] }

export class SessionService {
  private fileCache = new Map<string, CachedFile>()
  private lastSnapshot: PiSessionsSnapshot | null = null
  private fullScan = true
  private revision = 0
  private dirty = new Map<string, 'append' | 'rewrite'>()
  private scanning: Promise<PiSessionsSnapshot> | null = null
  private saving: Promise<void> = Promise.resolve()
  private saveTimer?: ReturnType<typeof setTimeout>
  private cacheDirty = false

  constructor(
    private readonly sessionsDirectory: string,
    private readonly cacheFile?: string,
  ) {}

  async init() {
    if (!this.cacheFile) return
    try {
      const data = JSON.parse(await readFile(this.cacheFile, 'utf8')) as SerializedCache
      if (
        data.version === 5 &&
        Array.isArray(data.files) &&
        data.files.every(
          ([file, item]) =>
            typeof file === 'string' &&
            typeof item.mtime === 'number' &&
            typeof item.ctime === 'number' &&
            typeof item.ino === 'number' &&
            typeof item.dev === 'number' &&
            typeof item.size === 'number' &&
            typeof item.index?.offset === 'number' &&
            typeof item.index.signature === 'string' &&
            typeof item.index.state?.messageCount === 'number' &&
            typeof item.index.state.firstMessage === 'string' &&
            typeof item.index.state.hasUserMessage === 'boolean' &&
            typeof item.index.state.appendSafe === 'boolean' &&
            (item.index.state.leafId === null || typeof item.index.state.leafId === 'string') &&
            (item.summary === null || (item.summary.path === file && typeof item.summary.cwd === 'string')),
        )
      )
        this.fileCache = new Map(data.files)
    } catch {
      /* 缓存损坏时重新建立索引，原始 JSONL 不变。 */
    }
  }
  private scheduleSave() {
    if (!this.cacheFile) return
    this.cacheDirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.flush()
    }, 1000)
    this.saveTimer.unref()
  }
  async flush() {
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    if (this.cacheFile && this.cacheDirty) {
      this.cacheDirty = false
      const cacheFile = this.cacheFile
      const text = JSON.stringify({ version: 5, files: [...this.fileCache] } satisfies SerializedCache)
      this.saving = this.saving
        .then(async () => {
          const temporary = `${cacheFile}.tmp`
          await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
          await rename(temporary, cacheFile)
        })
        .catch(() => {
          this.cacheDirty = true
        })
    }
    await this.saving
  }
  async getSessionsDirectory() {
    return this.sessionsDirectory
  }
  warmup() {
    void this.getSnapshot().catch(() => {})
  }
  /** 无参数用于启动恢复或显式重扫；运行状态通知不能调用全量失效。 */
  invalidate(file?: string, kind: 'append' | 'rewrite' = 'rewrite') {
    this.revision++
    if (!file) this.fullScan = true
    else if (!file.startsWith('runtime:')) this.dirty.set(file, this.dirty.get(file) === 'rewrite' ? 'rewrite' : kind)
  }
  private async update(file: string, append: boolean) {
    try {
      const info = await stat(file)
      const old = this.fileCache.get(file)
      if (
        old &&
        old.mtime === info.mtimeMs &&
        old.ctime === info.ctimeMs &&
        old.size === info.size &&
        old.ino === info.ino &&
        old.dev === info.dev
      )
        return
      const previous =
        append && old && old.ino === info.ino && old.dev === info.dev && info.size >= old.size ? old.index : undefined
      const result = await readSessionSummaryIndex(file, info.mtimeMs, info.size, previous)
      const after = await stat(file)
      if (
        after.ino !== info.ino ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs
      ) {
        this.invalidate(file, 'rewrite')
        return
      }
      this.fileCache.set(file, {
        mtime: info.mtimeMs,
        ctime: info.ctimeMs,
        size: info.size,
        ino: info.ino,
        dev: info.dev,
        ...result,
      })
      this.scheduleSave()
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        if (this.fileCache.delete(file)) this.scheduleSave()
      } else throw cause
    }
  }
  private async scan() {
    const revision = this.revision
    const full = this.fullScan
    this.fullScan = false
    const dirty = this.dirty
    this.dirty = new Map()
    try {
      let files = [...dirty.keys()]
      if (full) {
        files = []
        const directories = await readdir(this.sessionsDirectory, { withFileTypes: true }).catch(
          (cause: NodeJS.ErrnoException) => {
            if (cause.code === 'ENOENT') return []
            throw cause
          },
        )
        for (const directory of directories) {
          if (!directory.isDirectory()) continue
          const root = path.join(this.sessionsDirectory, directory.name)
          for (const name of await readdir(root)) if (name.endsWith('.jsonl')) files.push(path.join(root, name))
        }
        const existing = new Set(files)
        for (const file of this.fileCache.keys())
          if (!existing.has(file)) {
            this.fileCache.delete(file)
            this.scheduleSave()
          }
      }
      // stat 与解析合计最多四个任务，不随历史会话数量增加并发。
      for (let index = 0; index < files.length; index += 4) {
        const results = await Promise.allSettled(
          files.slice(index, index + 4).map((file) => this.update(file, !full && dirty.get(file) === 'append')),
        )
        const failure = results.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      }
      const visible = [...this.fileCache].filter(
        (entry): entry is [string, CachedFile & { summary: PiSessionSummary }] => entry[1].summary !== null,
      )
      const allFiles = visible
        .map(([file, item]) => ({ path: file, mtime: item.mtime }))
        .sort((a, b) => b.mtime - a.mtime)
      const byDirectory = new Map<string, typeof allFiles>()
      for (const file of allFiles) {
        const key = path.basename(path.dirname(file.path))
        const group = byDirectory.get(key) ?? []
        group.push(file)
        byDirectory.set(key, group)
      }
      const snapshot: PiSessionsSnapshot = {
        ...groupSessions(
          allFiles,
          byDirectory,
          new Map(visible.map(([file, item]) => [file, item.summary])),
          os.homedir(),
        ),
        pinnedPaths: [],
      }
      if (revision === this.revision) this.lastSnapshot = snapshot
      return snapshot
    } catch (cause) {
      this.fullScan ||= full
      for (const [file, kind] of dirty) this.invalidate(file, kind)
      throw cause
    }
  }
  async getSnapshot(
    active?: { sessionFile?: string; sessionId?: string; cwd?: string },
    pinnedPaths: string[] = [],
  ): Promise<PiSessionsSnapshot> {
    let result = this.lastSnapshot
    if (!result || this.fullScan || this.dirty.size || this.scanning) {
      if (!this.scanning)
        this.scanning = this.scan().finally(() => {
          this.scanning = null
        })
      result = await this.scanning
    }
    return { ...result, pinnedPaths, activeSessionId: active?.sessionId, activeSessionPath: active?.sessionFile }
  }
}
