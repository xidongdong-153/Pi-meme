import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'

export type SafeStorageAdapter = {
  isEncryptionAvailable: () => boolean
  encryptString: (value: string) => Buffer
  decryptString: (value: Buffer) => string
}

export class MemoryCredentialStorage implements SecureCredentialStorage {
  private values = new Map<string, string>()
  get(key: string) {
    return this.values.get(key)
  }
  set(key: string, value: string) {
    this.values.set(key, value)
  }
  delete(key: string) {
    return this.values.delete(key)
  }
  entries(prefix = '') {
    return [...this.values.entries()].filter(([key]) => key.startsWith(prefix))
  }
}

/** 使用 Electron safeStorage 加密整份凭据索引；文件中只保存密文。 */
export class SafeStorageCredentialStore implements SecureCredentialStorage {
  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageAdapter,
  ) {}

  private assertAvailable() {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，凭据操作已拒绝')
  }

  private read(): Record<string, string> {
    try {
      accessSync(this.filePath, constants.R_OK)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error('无法读取 Desktop 加密凭据文件')
    }
    this.assertAvailable()
    try {
      const encrypted = readFileSync(this.filePath)
      const parsed: unknown = JSON.parse(this.safeStorage.decryptString(encrypted))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid store')
      for (const [key, value] of Object.entries(parsed)) if (typeof value !== 'string') throw new Error(key)
      return parsed as Record<string, string>
    } catch {
      throw new Error('Desktop 加密凭据文件无法解密或格式无效')
    }
  }

  private write(records: Record<string, string>) {
    this.assertAvailable()
    const encrypted = this.safeStorage.encryptString(JSON.stringify(records))
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true })
      writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.filePath)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  get(key: string) {
    return this.read()[key]
  }

  set(key: string, value: string) {
    const records = this.read()
    records[key] = value
    this.write(records)
  }

  delete(key: string) {
    const records = this.read()
    if (!Object.hasOwn(records, key)) return false
    delete records[key]
    this.write(records)
    return true
  }

  entries(prefix = ''): Array<[string, string]> {
    return Object.entries(this.read()).filter(([key]) => key.startsWith(prefix))
  }
}

export function credentialId(namespace: string, value: string) {
  return `${namespace}:${createHash('sha256').update(value).digest('hex')}`
}
