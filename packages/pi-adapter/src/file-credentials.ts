import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'

const sealedCredentials = 'pi-meme:sealed-credentials'
const hostToken = 'host:token'
const sealHeader = Buffer.from('pi-meme credentials\0')
const nonceLength = 12
const tagLength = 16

async function writePrivate(file: string, contents: Buffer | string) {
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(contents)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function readKey(keyFile: string, initialize: boolean) {
  const key = await readFile(keyFile).catch(async (cause: NodeJS.ErrnoException) => {
    if (!initialize || cause.code !== 'ENOENT') throw cause
    const generated = randomBytes(32)
    await writePrivate(keyFile, generated)
    return generated
  })
  if (key.length !== 32) throw new Error('凭据加密密钥格式无效')
  await chmod(keyFile, 0o600)
  return key
}

function seal(values: Record<string, string>, key: Buffer) {
  const nonce = randomBytes(nonceLength)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(sealHeader)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64')
}

function unseal(value: string, key: Buffer) {
  const envelope = Buffer.from(value, 'base64')
  if (envelope.length <= nonceLength + tagLength) throw new Error('凭据密文格式无效')
  const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(0, nonceLength))
  decipher.setAAD(sealHeader)
  decipher.setAuthTag(envelope.subarray(nonceLength, nonceLength + tagLength))
  const plaintext = Buffer.concat([decipher.update(envelope.subarray(nonceLength + tagLength)), decipher.final()])
  return records(JSON.parse(plaintext.toString('utf8')))
}

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

  private constructor(
    readonly filePath: string,
    private readonly key: Buffer,
  ) {}

  static async create(dataRoot: string) {
    const filePath = path.join(dataRoot, storageLayoutRelativePaths.authFile)
    let source: string | undefined
    try {
      source = await readFile(filePath, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取 auth.json，请检查文件权限')
    }
    let stored: Record<string, string>
    try {
      stored = source === undefined ? records({}) : records(JSON.parse(source))
    } catch {
      throw new Error('auth.json 凭据格式无效，原文件未修改')
    }
    const encrypted = stored[sealedCredentials]
    try {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
      const key = await readKey(path.join(path.dirname(filePath), 'auth.key'), encrypted === undefined)
      const store = new FileCredentialStore(filePath, key)
      if (encrypted !== undefined) {
        const privateValues = unseal(encrypted, key)
        // Entries written by an older Host are kept when reopening the directory with a newer Host.
        delete stored[sealedCredentials]
        store.values = records({ ...privateValues, ...stored })
        if (Object.keys(stored).some((name) => name !== hostToken)) await store.persist(store.values)
        else await chmod(filePath, 0o600)
      } else {
        store.values = stored
        await store.persist(store.values)
      }
      store.committed = records(store.values)
      return store
    } catch {
      throw new Error('无法开启凭据存储，请检查 auth.json、auth.key 和数据目录权限')
    }
  }

  private persist(values: Record<string, string>) {
    // SSH 引导只读取本 Host 的访问令牌，其余记录通过 Host 解封。
    const { [hostToken]: token, ...privateValues } = values
    const encrypted = seal(privateValues, this.key)
    return writePrivate(this.filePath, `${JSON.stringify({ [hostToken]: token, [sealedCredentials]: encrypted })}\n`)
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
