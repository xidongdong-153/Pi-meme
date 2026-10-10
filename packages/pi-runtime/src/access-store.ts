import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaultAccessMode, isAgentAccessMode, type AgentAccessMode } from '@pi-meme/contracts/agent-access'

/** 保存已落盘会话的权限；写入串行执行，失败不更新内存记录。 */
export class AgentAccessStore {
  private records: Record<string, AgentAccessMode> = {}
  private loaded?: Promise<void>
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly file?: string) {}

  private load() {
    return (this.loaded ??= (async () => {
      if (!this.file) return
      let contents: string
      try {
        contents = await readFile(this.file, 'utf8')
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
        throw cause
      }
      const data: unknown = JSON.parse(contents)
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('会话权限记录无效')
      for (const [key, value] of Object.entries(data)) {
        if (!path.isAbsolute(key) || !isAgentAccessMode(value)) throw new Error('会话权限记录无效')
        this.records[key] = value
      }
    })())
  }

  private async key(sessionFile: string) {
    try {
      return await realpath(sessionFile)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      return path.join(await realpath(path.dirname(sessionFile)), path.basename(sessionFile))
    }
  }

  async get(sessionFile: string): Promise<AgentAccessMode> {
    await this.load()
    return this.records[await this.key(sessionFile)] ?? defaultAccessMode
  }

  async set(sessionFile: string, mode: AgentAccessMode) {
    const write = this.writes.then(async () => {
      await this.load()
      const key = await this.key(sessionFile)
      if (this.records[key] === mode) return
      const next = { ...this.records, [key]: mode }
      if (this.file) {
        await mkdir(path.dirname(this.file), { recursive: true })
        const temporary = `${this.file}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
          await rename(temporary, this.file)
        } finally {
          await rm(temporary, { force: true })
        }
      }
      this.records = next
    })
    this.writes = write.catch(() => {})
    return write
  }
}
