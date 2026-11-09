import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { UsageStatsSnapshot } from '@pi-meme/contracts/usage'
import { readBackgroundUsage } from './background-usage'

type UsageRecord = { key: string; date: string; tokens: number }
type FileUsage = { records: UsageRecord[]; longestTaskMs: number | null; warnings: string[] }
type Entry = Record<string, unknown>

function record(value: unknown): Entry | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Entry) : null
}

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function tokens(value: unknown): number | null {
  const usage = record(value)
  if (!usage) return null
  if (validNumber(usage.totalTokens)) return usage.totalTokens
  const components = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
  if (!components.some(validNumber) || components.some((value) => value !== undefined && !validNumber(value)))
    return null
  return components.reduce<number>((total, value) => total + (validNumber(value) ? value : 0), 0)
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

function localDate(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function previousDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return localDate(new Date(year, month - 1, day - 1).getTime())
}

async function readUsage(file: string): Promise<FileUsage> {
  const input = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  const records: UsageRecord[] = []
  const starts = new Map<string, number | null>()
  let linearStart: number | null = null
  let longestTaskMs: number | null = null
  let invalid = false
  let hasHeader = false
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      let entry: Entry | null
      try {
        entry = record(JSON.parse(line))
      } catch {
        invalid = true
        continue
      }
      if (!entry || typeof entry.type !== 'string') {
        invalid = true
        continue
      }
      if (entry.type === 'session') {
        hasHeader = true
        continue
      }
      if (!hasHeader) {
        invalid = true
        continue
      }
      const message = record(entry.message)
      const savedAt = timestamp(entry.timestamp)
      const time = savedAt ?? timestamp(message?.timestamp)
      let start: number | null = typeof entry.parentId === 'string' ? (starts.get(entry.parentId) ?? null) : linearStart
      if (entry.parentId === null) start = null
      if (entry.type === 'message' && message?.role === 'user') {
        start = timestamp(message.timestamp) ?? savedAt
      }
      if (
        entry.type === 'message' &&
        message?.role === 'assistant' &&
        (message.stopReason === 'stop' || message.stopReason === 'length') &&
        start !== null &&
        savedAt !== null &&
        savedAt >= start
      ) {
        longestTaskMs = Math.max(longestTaskMs ?? 0, savedAt - start)
        start = null
      }
      if (
        entry.type === 'message' &&
        message?.role === 'assistant' &&
        ['error', 'aborted'].includes(String(message.stopReason))
      )
        start = null
      if (typeof entry.id === 'string') starts.set(entry.id, start)
      linearStart = start

      const usage = entry.type === 'message' && message?.role === 'assistant' ? message.usage : entry.usage
      if (usage === undefined) continue
      const count = tokens(usage)
      if (count === null || time === null) {
        invalid = true
        continue
      }
      // 分叉会保留记录 ID 和正文，但可能改写 parentId，因此去重键不包含 parentId。
      const identity = JSON.stringify([entry.id, entry.type, entry.timestamp, message, entry.usage])
      const key = createHash('sha256').update(identity).digest('hex')
      records.push({ key, date: localDate(time), tokens: count })
    }
    return {
      records,
      longestTaskMs,
      warnings: invalid || !hasHeader ? [`${path.basename(file)} 包含无法读取的记录，统计可能不完整。`] : [],
    }
  } finally {
    lines.close()
    input.destroy()
  }
}

export class UsageService {
  private cache = new Map<string, { mtime: number; size: number; usage: FileUsage }>()
  private pending: Promise<UsageStatsSnapshot> | null = null

  constructor(
    private readonly sessionsDirectory: string,
    private readonly now: () => Date = () => new Date(),
    private readonly backgroundDirectory?: string,
  ) {}

  getSnapshot(): Promise<UsageStatsSnapshot> {
    if (this.pending) return this.pending
    this.pending = this.scan().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async scan(): Promise<UsageStatsSnapshot> {
    const directory = this.sessionsDirectory
    const files: string[] = []
    const warnings: string[] = []
    const collect = async (folder: string, root = false) => {
      try {
        const entries = await readdir(folder, { withFileTypes: true })
        for (const entry of entries) {
          const file = path.join(folder, entry.name)
          if (entry.isDirectory()) await collect(file)
          else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file)
        }
      } catch (cause) {
        if (root && (cause as NodeJS.ErrnoException).code === 'ENOENT') return
        if (root) throw new Error(`无法读取 Pi 会话目录：${String(cause)}`)
        warnings.push(`无法读取会话目录 ${path.basename(folder)}，统计可能不完整。`)
      }
    }
    await collect(directory, true)
    const present = new Set(files)
    for (const file of this.cache.keys()) if (!present.has(file)) this.cache.delete(file)
    const seen = new Set<string>()
    const daily = new Map<string, number>()
    let longestTaskMs: number | null = null
    for (const file of files) {
      try {
        const before = await stat(file)
        const cached = this.cache.get(file)
        const usage =
          cached?.mtime === before.mtimeMs && cached.size === before.size ? cached.usage : await readUsage(file)
        const after = await stat(file)
        if (before.mtimeMs === after.mtimeMs && before.size === after.size)
          this.cache.set(file, { mtime: before.mtimeMs, size: before.size, usage })
        else {
          this.cache.delete(file)
          warnings.push(`${path.basename(file)} 正在更新，请刷新以获取最新统计。`)
        }
        warnings.push(...usage.warnings)
        if (usage.longestTaskMs !== null) longestTaskMs = Math.max(longestTaskMs ?? 0, usage.longestTaskMs)
        for (const entry of usage.records) {
          if (seen.has(entry.key)) continue
          seen.add(entry.key)
          if (entry.tokens > 0) daily.set(entry.date, (daily.get(entry.date) ?? 0) + entry.tokens)
        }
      } catch {
        this.cache.delete(file)
        warnings.push(`无法读取会话 ${path.basename(file)}，统计可能不完整。`)
      }
    }
    let memoryUsage:
      | Pick<
          UsageStatsSnapshot,
          'memoryTotalTokens' | 'memoryCalls' | 'memoryUnknownCalls' | 'memoryKnownCost' | 'memoryUnknownCostCalls'
        >
      | undefined
    if (this.backgroundDirectory) {
      try {
        const records = await readBackgroundUsage(this.backgroundDirectory)
        let memoryTotalTokens = 0
        let memoryUnknownCalls = 0
        let memoryKnownCost = 0
        let memoryUnknownCostCalls = 0
        const memoryDaily = new Map<string, number>()
        for (const entry of records) {
          if (entry.outcome === 'unknown' || entry.tokens === undefined) memoryUnknownCalls += 1
          if (entry.cost === undefined) memoryUnknownCostCalls += 1
          else memoryKnownCost += entry.cost
          if (entry.tokens !== undefined) {
            memoryTotalTokens += entry.tokens
            const date = localDate(Date.parse(entry.timestamp))
            if (entry.tokens > 0) memoryDaily.set(date, (memoryDaily.get(date) ?? 0) + entry.tokens)
          }
        }
        if (!Number.isSafeInteger(memoryTotalTokens) || !Number.isFinite(memoryKnownCost))
          throw new Error('记忆用量超出统计数值范围。')
        memoryUsage = {
          memoryTotalTokens,
          memoryCalls: records.length,
          memoryUnknownCalls,
          memoryKnownCost,
          memoryUnknownCostCalls,
        }
        for (const [date, count] of memoryDaily) daily.set(date, (daily.get(date) ?? 0) + count)
        if (memoryUnknownCalls > 0) warnings.push(`记忆后台有 ${memoryUnknownCalls} 次调用结果或 Token 用量未知。`)
        if (memoryUnknownCostCalls > 0) warnings.push(`记忆后台有 ${memoryUnknownCostCalls} 次调用费用未知。`)
      } catch (cause) {
        warnings.push(`无法读取记忆后台用量，累计统计不完整：${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    const now = this.now()
    const today = localDate(now.getTime())
    const days = [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([date, tokens]) => ({ date, tokens }))
    let totalTokens = 0
    let peakDailyTokens = 0
    let longestStreak = 0
    let streak = 0
    let lastDate = ''
    for (const day of days) {
      totalTokens += day.tokens
      peakDailyTokens = Math.max(peakDailyTokens, day.tokens)
      if (day.date > today) continue
      streak = previousDate(day.date) === lastDate ? streak + 1 : 1
      longestStreak = Math.max(longestStreak, streak)
      lastDate = day.date
    }
    let currentStreak = 0
    let cursor = daily.has(today) ? today : previousDate(today)
    while (daily.has(cursor)) {
      currentStreak += 1
      cursor = previousDate(cursor)
    }
    return {
      updatedAt: now.toISOString(),
      today,
      totalTokens,
      peakDailyTokens,
      longestTaskMs,
      longestStreak,
      currentStreak,
      daily: days,
      warnings,
      ...memoryUsage,
    }
  }
}
