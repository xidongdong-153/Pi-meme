import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { memoryLimits } from '../shared/validation'

/** One writer, guarded against external edits. The service serializes all transactions. */
export class MemoryStore<T> {
  private fingerprint: string | null | undefined
  error?: string
  private readonly file: string
  constructor(
    private readonly directory: string,
    private readonly validate: (value: unknown) => asserts value is T,
  ) {
    this.file = path.join(directory, 'memory-state.json')
  }
  private hash(bytes: Uint8Array | string) {
    return createHash('sha256').update(bytes).digest('hex')
  }
  private async target() {
    for (const target of [this.directory, this.file]) {
      const info = await lstat(target).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return undefined
        throw cause
      })
      if (info?.isSymbolicLink()) throw new Error('记忆存储目录和文件不能是符号链接')
      if (info && (target === this.file ? !info.isFile() : !info.isDirectory())) throw new Error('记忆存储路径类型无效')
      if (target === this.file && info && info.size > memoryLimits.stateBytes) throw new Error('记忆存储超过20MiB')
    }
  }
  async load(): Promise<T | undefined> {
    try {
      await this.target()
      const bytes = await readFile(this.file)
      if (bytes.length > memoryLimits.stateBytes) throw new Error('记忆存储超过20MiB')
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      this.validate(value)
      this.fingerprint = this.hash(bytes)
      return value
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        this.fingerprint = null
        return undefined
      }
      this.error = `记忆文件已保护，不能覆盖：${String(cause)}`
      return undefined
    }
  }
  private async writable() {
    if (this.error || this.fingerprint === undefined) throw new Error(this.error ?? '记忆存储尚未初始化')
    await this.target()
    const bytes = await readFile(this.file).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return null
      throw cause
    })
    if ((bytes === null ? null : this.hash(bytes)) !== this.fingerprint)
      throw new Error('记忆文件被外部修改，请重启服务重新读取')
  }
  async save(value: T): Promise<void> {
    if (this.error) throw new Error(this.error)
    const raw = `${JSON.stringify(value)}\n`
    if (Buffer.byteLength(raw) > memoryLimits.stateBytes) throw new Error('记忆存储已达20MiB，请先清理记忆')
    this.validate(value)
    let renamed = false
    const temporary = path.join(this.directory, `.memory-${randomUUID()}.tmp`)
    try {
      await this.writable()
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(raw, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.writable()
      await rename(temporary, this.file)
      renamed = true
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r')
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
      this.fingerprint = this.hash(raw)
    } catch (cause) {
      this.error = renamed
        ? `记忆提交结果不确定，已停止写入；请重启服务重新读取：${String(cause)}`
        : `记忆写入已停止，原文件受保护：${String(cause)}`
      throw new Error(this.error)
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }
}
