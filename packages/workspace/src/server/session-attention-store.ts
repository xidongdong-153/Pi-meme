import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

type ReadRecord = { completionTokens: string[]; inputRequestIds: string[] }
type StoredAttention = { version: 1; revision: number; records: Array<[string, ReadRecord]> }
type Observation = { completionToken?: string; inputRequestIds?: string[] }
type AttentionInput = Observation & { inputRequestIds: string[]; running?: boolean; needsInput?: boolean }

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
}

function decode(value: unknown): StoredAttention {
  if (!value || typeof value !== 'object') throw new Error('已读状态文件不是有效对象')
  const data = value as StoredAttention
  const sessions = new Set<string>()
  if (
    data.version !== 1 ||
    !Number.isSafeInteger(data.revision) ||
    data.revision < 0 ||
    !Array.isArray(data.records) ||
    !data.records.every((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) return false
      const [id, record] = entry
      if (typeof id !== 'string' || !id || sessions.has(id) || !record || typeof record !== 'object') return false
      sessions.add(id)
      return strings(record.completionTokens) && strings(record.inputRequestIds)
    })
  )
    throw new Error('已读状态文件版本或记录无效')
  return data
}

/** Host 独占的查看记录；所有变更在原子落盘后才发布到内存。 */
export class SessionAttentionStore {
  private data?: StoredAttention
  private records = new Map<string, { completionTokens: Set<string>; inputRequestIds: Set<string> }>()
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.pending.catch(() => {}).then(operation)
    this.pending = job.then(() => {})
    // 调用方负责处理原始 job 的错误，队列内部不产生独立的未处理 rejection。
    void this.pending.catch(() => {})
    return job
  }

  private publish(data: StoredAttention) {
    this.data = data
    this.records = new Map(
      data.records.map(([id, record]) => [
        id,
        { completionTokens: new Set(record.completionTokens), inputRequestIds: new Set(record.inputRequestIds) },
      ]),
    )
  }

  private current() {
    if (!this.data) throw new Error('会话已读状态尚未初始化')
    return this.data
  }

  private async save(data: StoredAttention) {
    await mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(data), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, this.file)
    } catch (cause) {
      throw new Error(`无法保存会话已读状态：${String(cause)}`, { cause })
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
    this.publish(data)
  }

  init(initial: Array<{ sessionId: string; completionToken?: string }>): Promise<void> {
    return this.serial(async () => {
      if (this.data) return
      let text: string
      try {
        text = await readFile(this.file, 'utf8')
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new Error(`无法读取会话已读状态，未重置初始化：${String(cause)}`, { cause })
        const records = new Map<string, Set<string>>()
        for (const entry of initial) {
          if (!entry.completionToken) continue
          const tokens = records.get(entry.sessionId) ?? new Set<string>()
          tokens.add(entry.completionToken)
          records.set(entry.sessionId, tokens)
        }
        await this.save({
          version: 1,
          revision: 0,
          records: [...records].map(([id, tokens]) => [id, { completionTokens: [...tokens], inputRequestIds: [] }]),
        })
        return
      }
      try {
        this.publish(decode(JSON.parse(text)))
      } catch (cause) {
        throw new Error(`会话已读状态文件损坏或不兼容，未重置初始化：${String(cause)}`, { cause })
      }
    })
  }

  snapshot(sessionId: string, input: AttentionInput): { revision: number; unread: boolean; inputUnread: boolean } {
    const data = this.current()
    const record = this.records.get(sessionId)
    return {
      revision: data.revision,
      unread: Boolean(input.completionToken && !input.running && !record?.completionTokens.has(input.completionToken)),
      inputUnread: Boolean(
        input.needsInput &&
        (!input.inputRequestIds.length || input.inputRequestIds.some((id) => !record?.inputRequestIds.has(id))),
      ),
    }
  }

  markRead(sessionId: string, observed: Observation): Promise<boolean> {
    return this.serial(async () => {
      const data = this.current()
      const saved = this.records.get(sessionId)
      const completionTokens = new Set(saved?.completionTokens)
      const inputRequestIds = new Set(saved?.inputRequestIds)
      if (observed.completionToken) completionTokens.add(observed.completionToken)
      for (const id of observed.inputRequestIds ?? []) inputRequestIds.add(id)
      if (
        completionTokens.size === (saved?.completionTokens.size ?? 0) &&
        inputRequestIds.size === (saved?.inputRequestIds.size ?? 0)
      )
        return false
      const records = new Map(data.records)
      records.set(sessionId, { completionTokens: [...completionTokens], inputRequestIds: [...inputRequestIds] })
      await this.save({ version: 1, revision: data.revision + 1, records: [...records] })
      return true
    })
  }

  removeSessions(ids: string[]): Promise<void> {
    return this.serial(async () => {
      const data = this.current()
      const records = new Map(data.records)
      let changed = false
      for (const id of ids) changed = records.delete(id) || changed
      if (changed) await this.save({ version: 1, revision: data.revision + 1, records: [...records] })
    })
  }

  async flush(): Promise<void> {
    await this.pending
  }
}
