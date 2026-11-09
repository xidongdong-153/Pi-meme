import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import type { MemoryUsageRecord } from '@pi-meme/contracts/memory'

const filename = 'background-usage.jsonl'
const maxLineBytes = 4096
const decoder = new TextDecoder('utf-8', { fatal: true })

type LoadedJournal = { records: Map<string, MemoryUsageRecord>; size: number }

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('后台用量记录必须是对象。')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('后台用量记录含未允许的字段。')
}

function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    Buffer.byteLength(value) > 256 ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error('后台用量标识无效。')
  return value
}

function validate(value: unknown): MemoryUsageRecord {
  const input = object(value)
  exactKeys(input, ['attemptId', 'purpose', 'model', 'timestamp', 'outcome', 'tokens', 'cost'])
  const model = object(input.model)
  exactKeys(model, ['provider', 'id'])
  if (input.purpose !== 'memory.extract' && input.purpose !== 'memory.consolidate')
    throw new Error('后台用量用途无效。')
  if (input.outcome !== 'completed' && input.outcome !== 'failed' && input.outcome !== 'unknown')
    throw new Error('后台用量结果无效。')
  if (
    typeof input.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(input.timestamp)) ||
    new Date(input.timestamp).toISOString() !== input.timestamp
  )
    throw new Error('后台用量时间必须是规范 ISO 时间。')
  if (input.tokens !== undefined && (!Number.isSafeInteger(input.tokens) || (input.tokens as number) < 0))
    throw new Error('后台用量 Token 必须是非负安全整数。')
  if (input.cost !== undefined && (typeof input.cost !== 'number' || !Number.isFinite(input.cost) || input.cost < 0))
    throw new Error('后台用量费用必须是非负有限数值。')
  const result: MemoryUsageRecord = {
    attemptId: identifier(input.attemptId),
    purpose: input.purpose,
    model: { provider: identifier(model.provider), id: identifier(model.id) },
    timestamp: input.timestamp,
    outcome: input.outcome,
    ...(input.tokens !== undefined ? { tokens: input.tokens as number } : {}),
    ...(input.cost !== undefined ? { cost: input.cost as number } : {}),
  }
  if (Buffer.byteLength(JSON.stringify(result)) + 1 > maxLineBytes) throw new Error('后台用量记录过长。')
  return result
}

async function load(file: string): Promise<LoadedJournal> {
  const records = new Map<string, MemoryUsageRecord>()
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('后台用量日志不是普通文件。')
    const chunk = Buffer.alloc(8192)
    let remaining = Buffer.alloc(0)
    let position = 0
    let lineNumber = 0
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (!bytesRead) break
      position += bytesRead
      const data = Buffer.concat([remaining, chunk.subarray(0, bytesRead)])
      let start = 0
      let end = data.indexOf(10, start)
      while (end !== -1) {
        lineNumber += 1
        if (end - start + 1 > maxLineBytes) throw new Error(`后台用量日志第 ${lineNumber} 行过长。`)
        let entry: MemoryUsageRecord
        try {
          entry = validate(JSON.parse(decoder.decode(data.subarray(start, end))))
        } catch {
          throw new Error(`后台用量日志第 ${lineNumber} 行损坏，已停止读取和追加。`)
        }
        const previous = records.get(entry.attemptId)
        if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
          throw new Error(`后台用量日志第 ${lineNumber} 行存在冲突的调用标识。`)
        records.set(entry.attemptId, entry)
        start = end + 1
        end = data.indexOf(10, start)
      }
      remaining = data.subarray(start)
      if (remaining.length >= maxLineBytes) throw new Error(`后台用量日志第 ${lineNumber + 1} 行过长。`)
    }
    if (remaining.length) throw new Error('后台用量日志尾行不完整，已停止读取和追加。')
    return { records, size: position }
  } finally {
    await handle.close()
  }
}

/** Read-only aggregation path; corrupt or truncated journals never become an empty successful snapshot. */
export async function readBackgroundUsage(directory: string): Promise<readonly MemoryUsageRecord[]> {
  return [...(await load(path.join(directory, filename))).records.values()]
}

/** One Host owns this append-only journal. Memory outbox delivery resolves only after fsync. */
export class BackgroundUsageJournal {
  private readonly file: string
  private initialization?: Promise<void>
  private queue: Promise<void> = Promise.resolve()
  private records = new Map<string, MemoryUsageRecord>()
  private size = 0
  private failure?: Error

  constructor(private readonly directory: string) {
    this.file = path.join(directory, filename)
  }

  init(): Promise<void> {
    this.initialization ??= this.initialize()
    return this.initialization
  }

  record(input: MemoryUsageRecord): Promise<void> {
    let entry: MemoryUsageRecord
    try {
      entry = validate(input)
    } catch (cause) {
      return Promise.reject(cause)
    }
    const operation = this.queue.then(async () => {
      await this.init()
      if (this.failure) throw this.failure
      const previous = this.records.get(entry.attemptId)
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(entry)) throw new Error('后台用量调用标识已存在且内容不一致。')
        return
      }
      const line = `${JSON.stringify(entry)}\n`
      const handle = await open(this.file, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0))
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size !== this.size) throw new Error('后台用量日志已被外部更改，停止追加。')
        await handle.chmod(0o600)
        await handle.writeFile(line, 'utf8')
        await handle.sync()
        this.size += Buffer.byteLength(line)
        this.records.set(entry.attemptId, entry)
      } catch (cause) {
        this.failure = new Error('后台用量日志追加未确认，需检查日志后重启。', { cause })
        throw this.failure
      } finally {
        await handle.close()
      }
    })
    this.queue = operation.catch(() => {})
    return operation
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const directory = await lstat(this.directory)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('后台用量目录必须是实际目录。')
    const handle = await open(
      this.file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    ).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw cause
    })
    if (handle) {
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (process.platform !== 'win32') {
        const directoryHandle = await open(this.directory, constants.O_RDONLY)
        try {
          await directoryHandle.sync()
        } finally {
          await directoryHandle.close()
        }
      }
    }
    const permissionHandle = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      if (!(await permissionHandle.stat()).isFile()) throw new Error('后台用量日志不是普通文件。')
      await permissionHandle.chmod(0o600)
    } finally {
      await permissionHandle.close()
    }
    const loaded = await load(this.file)
    this.records = loaded.records
    this.size = loaded.size
  }
}
