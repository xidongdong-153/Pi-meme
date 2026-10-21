import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'

function records(value: unknown): Record<string, string> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((v) => typeof v !== 'string')
  )
    throw new Error('auth.json 凭据格式无效，必须为字符串键值对象')
  return Object.assign(Object.create(null), value)
}

/** Host 持有数据目录锁；Worker 只同步内存副本。 */
export class FileCredentialStore implements SecureCredentialStorage {
  private values: Record<string, string> = Object.create(null)
  private committed: Record<string, string> = Object.create(null)
  private writes: Promise<void> = Promise.resolve()
  private failure?: Error

  private constructor(readonly filePath: string) {}

  static async create(dataRoot: string) {
    const filePath = path.join(dataRoot, storageLayoutRelativePaths.authFile)
    const store = new FileCredentialStore(filePath)
    let source: string
    try {
      source = await readFile(store.filePath, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取 auth.json，请检查文件权限')
      try {
        await store.persist(store.values)
      } catch {
        throw new Error('无法初始化 auth.json，请检查数据目录权限')
      }
      return store
    }
    try {
      store.values = records(JSON.parse(source))
    } catch {
      throw new Error('auth.json 凭据格式无效，原文件未修改')
    }
    try {
      await chmod(store.filePath, 0o600)
    } catch {
      throw new Error('无法设置 auth.json 的 0600 权限，请检查文件权限')
    }
    store.committed = records(store.values)
    return store
  }

  private async persist(value: Record<string, string>) {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.filePath)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private enqueue(value: Record<string, string>) {
    if (this.failure) throw this.failure
    this.values = records(value)
    const snapshot = records(value)
    this.writes = this.writes.then(async () => {
      try {
        await this.persist(snapshot)
        this.committed = snapshot
      } catch {
        this.values = records(this.committed)
        this.failure = new Error('无法写入 auth.json，凭据未保存，请检查数据目录权限')
        throw this.failure
      }
    })
    void this.writes.catch(() => {})
  }

  flush() {
    return this.writes
  }
  get(key: string) {
    return this.values[key]
  }
  set(key: string, value: string) {
    this.enqueue({ ...this.values, [key]: value })
  }
  delete(key: string) {
    if (!Object.hasOwn(this.values, key)) return false
    const next = { ...this.values }
    delete next[key]
    this.enqueue(next)
    return true
  }
  entries(prefix = ''): Array<[string, string]> {
    return Object.entries(this.values).filter(([key]) => key.startsWith(prefix))
  }
  async importMissing(entries: Array<[string, string]>) {
    const next = { ...this.values }
    let imported = 0
    for (const [key, value] of entries) {
      if (Object.hasOwn(next, key)) continue
      Object.defineProperty(next, key, { value, enumerable: true, configurable: true, writable: true })
      imported++
    }
    if (imported) this.enqueue(next)
    await this.flush()
    return { imported, skipped: entries.length - imported }
  }
}
