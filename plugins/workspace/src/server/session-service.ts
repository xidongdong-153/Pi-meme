import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { PiSessionsSnapshot, PiSessionSummary } from '@pi-meme/contracts/sessions'

import { readSessionSummary } from './session-reader'
import { groupSessions } from './session-groups'

type SerializedCache = {
  version: 3
  fileCache: [string, { mtime: number; size: number; summary: PiSessionSummary | null }][]
  dirCache: [string, { mtime: number; files: { path: string; mtime: number; size: number; dirName: string }[] }][]
}

export class SessionService {
  private fileCache = new Map<string, { mtime: number; size: number; summary: PiSessionSummary | null }>()
  private dirCache = new Map<
    string,
    { mtime: number; files: { path: string; mtime: number; size: number; dirName: string }[]; cwd?: string }
  >()
  private lastSnapshot: PiSessionsSnapshot | null = null
  private lastScan = 0
  private revision = 0
  private scanning: Promise<PiSessionsSnapshot> | null = null
  private saving: Promise<void> = Promise.resolve()
  private readonly ttlMs = 2000

  constructor(
    private readonly sessionsDirectory: string,
    private readonly cacheFile?: string,
  ) {}

  async init() {
    if (!this.cacheFile) return
    try {
      const text = await readFile(this.cacheFile, 'utf8')
      const data = JSON.parse(text) as SerializedCache
      if (data && data.version === 3) {
        if (Array.isArray(data.fileCache)) this.fileCache = new Map(data.fileCache)
        if (Array.isArray(data.dirCache)) this.dirCache = new Map(data.dirCache)
      }
    } catch {
      // 容错处理：文件不存在或损坏时使用空缓存
    }
  }

  private saveCache() {
    if (!this.cacheFile) return
    const cacheFile = this.cacheFile
    const data: SerializedCache = {
      version: 3,
      fileCache: Array.from(this.fileCache.entries()).slice(-500),
      dirCache: Array.from(this.dirCache.entries()),
    }
    this.saving = this.saving
      .then(async () => {
        const tmp = `${cacheFile}.tmp`
        await writeFile(tmp, JSON.stringify(data), 'utf8')
        await rename(tmp, cacheFile)
      })
      .catch(() => {})
    return this.saving
  }

  async getSessionsDirectory() {
    return this.sessionsDirectory
  }

  warmup() {
    void this.getSnapshot().catch(() => {})
  }

  invalidate() {
    this.revision += 1
    this.lastScan = 0
    this.lastSnapshot = null
  }

  private async parseSessionQuick(filePath: string, mtime: number, size: number): Promise<PiSessionSummary | null> {
    const cached = this.fileCache.get(filePath)
    if (cached && cached.mtime === mtime && cached.size === size) {
      return cached.summary
    }

    const summary = await readSessionSummary(filePath, mtime)
    try {
      const after = await stat(filePath)
      if (after.mtimeMs === mtime && after.size === size) this.fileCache.set(filePath, { mtime, size, summary })
    } catch {
      this.fileCache.delete(filePath)
    }
    return summary
  }

  async getSnapshot(
    active?: { sessionFile?: string; sessionId?: string; cwd?: string },
    pinnedPaths: string[] = [],
  ): Promise<PiSessionsSnapshot> {
    const now = Date.now()
    if (this.lastSnapshot && now - this.lastScan < this.ttlMs) {
      return {
        ...this.lastSnapshot,
        pinnedPaths,
        activeSessionId: active?.sessionId,
        activeSessionPath: active?.sessionFile,
      }
    }

    if (this.scanning) {
      const result = await this.scanning
      return {
        ...result,
        pinnedPaths,
        activeSessionId: active?.sessionId,
        activeSessionPath: active?.sessionFile,
      }
    }

    const revision = this.revision
    this.scanning = (async () => {
      try {
        const home = os.homedir()
        const sessionsDir = this.sessionsDirectory

        let dirEntries: { name: string; isDirectory: boolean }[] = []
        try {
          const raw = await readdir(sessionsDir, { withFileTypes: true })
          dirEntries = raw.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }))
        } catch {
          return {
            recents: [],
            projects: [],
            pinnedPaths,
            activeSessionId: active?.sessionId,
            activeSessionPath: active?.sessionFile,
          }
        }

        const projectDirs = dirEntries.filter((d) => d.isDirectory)
        const directories = new Set(projectDirs.map((directory) => directory.name))
        for (const name of this.dirCache.keys()) if (!directories.has(name)) this.dirCache.delete(name)
        const allFiles: { path: string; mtime: number; size: number; dirName: string }[] = []
        const filesByDir = new Map<string, { path: string; mtime: number; size: number }[]>()

        await Promise.all(
          projectDirs.map(async (dir) => {
            const fullDir = path.join(sessionsDir, dir.name)
            try {
              const dirStat = await stat(fullDir)
              const cachedDir = this.dirCache.get(dir.name)
              if (cachedDir && cachedDir.mtime === dirStat.mtimeMs) {
                const files = (
                  await Promise.all(
                    cachedDir.files.map(async (file) => {
                      try {
                        const stats = await stat(file.path)
                        return { ...file, mtime: stats.mtimeMs, size: stats.size }
                      } catch {
                        return null
                      }
                    }),
                  )
                ).filter((file): file is NonNullable<typeof file> => file !== null)
                files.sort((a, b) => b.mtime - a.mtime)
                cachedDir.files = files
                filesByDir.set(dir.name, files)
                allFiles.push(...files)
                return
              }

              const fileList = await readdir(fullDir)
              const jsonlFiles = fileList.filter((f) => f.endsWith('.jsonl'))
              const filesWithStat = await Promise.all(
                jsonlFiles.map(async (file) => {
                  const fullFilePath = path.join(fullDir, file)
                  try {
                    const s = await stat(fullFilePath)
                    return { path: fullFilePath, mtime: s.mtimeMs, size: s.size, dirName: dir.name }
                  } catch {
                    return null
                  }
                }),
              )
              const valid = filesWithStat.filter((f): f is NonNullable<typeof f> => f !== null)
              valid.sort((a, b) => b.mtime - a.mtime)
              this.dirCache.set(dir.name, { mtime: dirStat.mtimeMs, files: valid })
              filesByDir.set(dir.name, valid)
              allFiles.push(...valid)
            } catch {
              // 忽略单个目录读取错误
            }
          }),
        )

        // 全局按最后修改时间倒序排列
        allFiles.sort((a, b) => b.mtime - a.mtime)

        // 未变化的摘要直接使用缓存，其余文件读取首条消息与最近完成记录。
        const paths = new Set(allFiles.map((file) => file.path))
        for (const cachedPath of this.fileCache.keys()) if (!paths.has(cachedPath)) this.fileCache.delete(cachedPath)
        const toParse = allFiles
        const parsedSummaries: (PiSessionSummary | null)[] = []
        for (let index = 0; index < toParse.length; index += 16) {
          parsedSummaries.push(
            ...(await Promise.all(
              toParse.slice(index, index + 16).map((file) => this.parseSessionQuick(file.path, file.mtime, file.size)),
            )),
          )
        }
        const summaryMap = new Map<string, PiSessionSummary>()
        for (const s of parsedSummaries) {
          if (s) summaryMap.set(s.path, s)
        }

        const skipped = new Set(toParse.filter((_, index) => parsedSummaries[index] === null).map((file) => file.path))
        const visibleFiles = allFiles.filter((file) => !skipped.has(file.path))
        const visibleDirectories = new Map(
          [...filesByDir].map(([name, files]) => [name, files.filter((file) => !skipped.has(file.path))]),
        )
        const { recents, projects } = groupSessions(visibleFiles, visibleDirectories, summaryMap, home)

        const snapshot: PiSessionsSnapshot = {
          recents,
          projects,
          pinnedPaths,
          activeSessionId: active?.sessionId,
          activeSessionPath: active?.sessionFile,
        }

        if (revision === this.revision) {
          this.lastSnapshot = snapshot
          this.lastScan = Date.now()
        }
        void this.saveCache()
        return snapshot
      } finally {
        this.scanning = null
      }
    })()

    return this.scanning
  }
}
