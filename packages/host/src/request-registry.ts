import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import path from 'node:path'
import type { HostRpcRequest, HostRpcResponse } from '@pi-meme/contracts/host'
import { pluginFailure } from '@pi-meme/contracts/plugin-call'

export type RequestJournalEntry = {
  k: string // sha256(clientId:requestId)
  i: string // sha256(input)
  t: string // ISO timestamp
}

export function validateRequestEntry(entry: unknown): asserts entry is RequestJournalEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('请求日志条目必须是对象')
  }
  const item = entry as Partial<RequestJournalEntry>
  if (typeof item.k !== 'string' || !/^[a-f0-9]{64}$/.test(item.k)) {
    throw new Error('请求日志条目 k 字段无效')
  }
  if (typeof item.i !== 'string' || !/^[a-f0-9]{64}$/.test(item.i)) {
    throw new Error('请求日志条目 i 字段无效')
  }
}

/** 一次性从旧版 requests/ 目录导入历史标记至 requests.jsonl，原子写临时文件后替换，支持安全重入去重 */
export async function importLegacyRequests(legacyDirectory: string, journalFile: string): Promise<number> {
  const { readdir } = await import('node:fs/promises')
  const seenKeys = new Set<string>()
  const existingEntries: RequestJournalEntry[] = []

  try {
    const existingContent = await readFile(journalFile, 'utf8')
    const lines = existingContent.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim()
      if (!line) continue
      const entry = JSON.parse(line)
      validateRequestEntry(entry)
      seenKeys.add(entry.k)
      existingEntries.push(entry)
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }

  let files: string[] = []
  try {
    files = await readdir(legacyDirectory)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw cause
  }

  const newEntries: RequestJournalEntry[] = []
  for (const file of files) {
    if (!/^[a-f0-9]{64}$/.test(file)) {
      throw new Error(`旧版 requests 目录包含非法的请求标识文件：${file}`)
    }
    const inputHash = (await readFile(path.join(legacyDirectory, file), 'utf8')).trim()
    if (!/^[a-f0-9]{64}$/.test(inputHash)) {
      throw new Error(`旧版请求标识文件内容损坏：${file}`)
    }
    if (!seenKeys.has(file)) {
      seenKeys.add(file)
      newEntries.push({
        k: file,
        i: inputHash,
        t: new Date().toISOString(),
      })
    }
  }

  const allEntries = [...existingEntries, ...newEntries]
  await mkdir(path.dirname(journalFile), { recursive: true })
  const tmpFile = `${journalFile}.tmp`
  const content = allEntries.map((e) => JSON.stringify(e)).join('\n')
  const fileHandle = await open(tmpFile, 'w', 0o600)
  try {
    if (content) {
      await fileHandle.write(`${content}\n`)
    }
    await fileHandle.sync()
  } finally {
    await fileHandle.close()
  }
  await rename(tmpFile, journalFile)
  return newEntries.length
}

/**
 * 写请求 ID 单文件追加持久化；结果缓存淘汰后明确拒绝重放。
 * 读请求不落盘；512 内存结果缓存不淘汰执行中请求；不可读或中段损坏时拒绝写请求。
 */
export class RequestRegistry {
  private readonly requests = new Map<string, { input: string; result: Promise<HostRpcResponse> }>()
  private readonly expired = new Set<string>()
  private readonly completed: string[] = []
  private readonly persistedKeys = new Set<string>()
  private journalInitialized?: Promise<void>
  private brokenError?: Error
  private appendQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly hostId: string,
    private readonly journalFile?: string,
    private readonly capacity = 512,
  ) {}

  private initJournal(): Promise<void> {
    if (!this.journalFile) return Promise.resolve()
    if (this.journalInitialized) return this.journalInitialized
    const pending = (async () => {
      let rawContent: Buffer
      try {
        rawContent = await readFile(this.journalFile!)
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
        this.brokenError = new Error(`无法读取请求日志文件：${String(cause)}`)
        throw this.brokenError
      }
      const text = rawContent.toString('utf8')
      const hasTrailingNewline = text.endsWith('\n')
      const lines = text.split('\n')
      // 如果末尾没有换行，说明最后一行是不完整尾行（崩溃导致未写完）
      const completeLines = hasTrailingNewline ? lines.slice(0, -1) : lines.slice(0, -1)
      const incompleteTail = hasTrailingNewline ? '' : (lines[lines.length - 1] ?? '')

      for (let index = 0; index < completeLines.length; index++) {
        const line = completeLines[index]?.trim()
        if (!line) continue
        try {
          const entry = JSON.parse(line)
          validateRequestEntry(entry)
          this.persistedKeys.add(entry.k)
        } catch (cause) {
          this.brokenError = new Error(`请求日志数据损坏（第 ${index + 1} 行）：${String(cause)}`)
          throw this.brokenError
        }
      }

      if (incompleteTail.trim()) {
        // 发现未完成尾行，物理截断到最后一个换行符位置，防止后续追加拼接坏行
        const validBytes = rawContent.lastIndexOf(0x0a) + 1
        const handle = await open(this.journalFile!, 'r+', 0o600)
        try {
          await handle.truncate(validBytes)
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    })()
    this.journalInitialized = pending
    return pending
  }

  private appendJournal(keyHash: string, inputHash: string): Promise<void> {
    if (!this.journalFile) {
      this.persistedKeys.add(keyHash)
      return Promise.resolve()
    }
    const line = `${JSON.stringify({ k: keyHash, i: inputHash, t: new Date().toISOString() })}\n`
    const pending = this.appendQueue
      .then(async () => {
        if (this.brokenError) throw this.brokenError
        await mkdir(path.dirname(this.journalFile!), { recursive: true })
        const handle = await open(this.journalFile!, 'a', 0o600)
        try {
          await handle.write(line)
          await handle.sync()
        } finally {
          await handle.close()
        }
        this.persistedKeys.add(keyHash)
      })
      .catch((cause) => {
        this.brokenError = new Error(`追加请求日志失败：${String(cause)}`)
        throw this.brokenError
      })
    this.appendQueue = pending.catch(() => {})
    return pending
  }

  run(request: HostRpcRequest, action: () => Promise<unknown>, retain = true): Promise<HostRpcResponse> {
    const key = `${request.clientId}:${request.requestId}`
    const input = JSON.stringify([request.method, request.sessionId, request.args])
    const keyHash = createHash('sha256').update(key).digest('hex')
    const inputHash = createHash('sha256').update(input).digest('hex')

    const error = (code: string, message: string): HostRpcResponse => ({
      requestId: request.requestId,
      hostId: this.hostId,
      error: { code, message },
    })

    const previous = this.requests.get(key)
    if (retain && previous) {
      if (previous.input !== input) return Promise.resolve(error('request-conflict', '请求 ID 已用于其他操作'))
      return previous.result
    }

    const result = Promise.resolve()
      .then(async () => {
        if (retain) {
          if (this.journalFile) {
            try {
              await this.initJournal()
            } catch {
              return error('journal-corrupted', this.brokenError?.message ?? '请求去重日志不可用，拒绝执行写操作')
            }
          }
          if (this.brokenError !== undefined) {
            const err = this.brokenError as Error
            return error('journal-corrupted', err.message)
          }
          if (this.expired.has(key) || this.persistedKeys.has(keyHash)) {
            return error('request-expired', '请求已经接纳，结果已过期；操作没有重新执行')
          }
          if (this.journalFile) {
            try {
              await this.appendJournal(keyHash, inputHash)
            } catch {
              const err = this.brokenError as Error | undefined
              return error('journal-corrupted', err?.message ?? '写操作持久化登记失败，拒绝执行')
            }
          } else {
            this.persistedKeys.add(keyHash)
          }
        }
        const value = await action()
        return { requestId: request.requestId, hostId: this.hostId, result: value }
      })
      .catch((cause: unknown) => {
        const failure = request.method.startsWith('plugins:')
          ? pluginFailure(cause)
          : { code: 'operation-failed', message: cause instanceof Error ? cause.message : String(cause) }
        return error(failure.code, failure.message)
      })

    if (retain) {
      this.requests.set(key, { input, result })
      void result.then(() => {
        this.completed.push(key)
        if (this.completed.length > this.capacity) {
          const oldest = this.completed.shift()
          if (oldest !== undefined) {
            this.requests.delete(oldest)
            this.expired.add(oldest)
          }
        }
      })
    }
    return result
  }
}
