import { createHash } from 'node:crypto'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'

export type KeychainAdapter = {
  getPassword: () => Promise<string | null | undefined>
  setPassword: (value: string) => Promise<void>
}

/** Host 是唯一写入者；异步钥匙串操作不会阻塞会话事件。 */
export class KeychainCredentialStore implements SecureCredentialStorage {
  private records: Record<string, string> = {}
  private writes: Promise<void> = Promise.resolve()
  private failure?: Error
  private constructor(private readonly adapter: KeychainAdapter) {}
  static async create(dataRoot: string, adapter?: KeychainAdapter) {
    if (!adapter) {
      if (process.platform !== 'darwin') throw new Error('系统凭据存储目前仅支持 macOS')
      const { AsyncEntry } = await import('@napi-rs/keyring')
      adapter = new AsyncEntry(`pi-meme:${createHash('sha256').update(dataRoot).digest('hex')}`, 'host')
    }
    const store = new KeychainCredentialStore(adapter)
    let value: string | null | undefined
    try {
      value = await adapter.getPassword()
    } catch {
      throw new Error('无法读取 macOS 钥匙串，请检查钥匙串是否已解锁')
    }
    if (value !== undefined && value !== null) {
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        throw new Error('钥匙串凭据格式无效')
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((item) => typeof item !== 'string')
      )
        throw new Error('钥匙串凭据格式无效')
      store.records = parsed as Record<string, string>
    }
    return store
  }
  private enqueue(update: (records: Record<string, string>) => void) {
    if (this.failure) throw this.failure
    update(this.records)
    const snapshot = JSON.stringify(this.records)
    this.writes = this.writes.then(async () => {
      try {
        await this.adapter.setPassword(snapshot)
      } catch {
        this.failure = new Error('无法写入 macOS 钥匙串，凭据未保存')
        throw this.failure
      }
    })
    void this.writes.catch(() => {})
  }
  flush() {
    return this.writes
  }
  get(key: string) {
    if (this.failure) throw this.failure
    return this.records[key]
  }
  set(key: string, value: string) {
    this.enqueue((records) => {
      records[key] = value
    })
  }
  delete(key: string) {
    if (!Object.hasOwn(this.records, key)) return false
    this.enqueue((records) => {
      delete records[key]
    })
    return true
  }
  entries(prefix = ''): Array<[string, string]> {
    return Object.entries(this.records).filter(([key]) => key.startsWith(prefix))
  }
}
