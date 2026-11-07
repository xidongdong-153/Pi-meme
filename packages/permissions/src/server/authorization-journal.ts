import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'

const journalVersion = 2
class AuthorizationJournalVersionError extends Error {}

export function canonicalAuthorizationJson(value: unknown): string {
  const ancestors = new Set<object>()
  const visit = (item: unknown): string => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item)
    if (typeof item !== 'object' || item === null) throw new Error('授权输入必须是有限 JSON 值')
    if (ancestors.has(item)) throw new Error('授权输入不能循环引用')
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new Error('授权输入必须是普通 JSON 对象')
    ancestors.add(item)
    const result = Array.isArray(item)
      ? `[${Array.from(item, visit).join(',')}]`
      : `{${Object.keys(item)
          .sort()
          .filter((key) => Reflect.get(item, key) !== undefined)
          .map((key) => `${JSON.stringify(key)}:${visit(Reflect.get(item, key))}`)
          .join(',')}}`
    ancestors.delete(item)
    return result
  }
  const result = visit(value)
  if (Buffer.byteLength(result) > 1_048_576) throw new Error('授权输入超过 1 MiB')
  return result
}

export function authorizationDigest(value: unknown): string {
  return createHash('sha256').update(canonicalAuthorizationJson(value)).digest('hex')
}

/** One Host writer, append + fsync before publication; any malformed tail fails closed. */
export class AuthorizationJournal {
  private fd: number | undefined
  private sequence = 0
  private previous = '0'.repeat(64)
  private readonly lockPath: string

  constructor(
    private readonly filename: string,
    consume: (payload: unknown) => void,
  ) {
    mkdirSync(path.dirname(filename), { recursive: true })
    this.lockPath = `${filename}.lock`
    if (existsSync(this.lockPath)) {
      const owner: unknown = JSON.parse(readFileSync(this.lockPath, 'utf8'))
      if (
        !owner ||
        typeof owner !== 'object' ||
        !('pid' in owner) ||
        !Number.isSafeInteger(owner.pid) ||
        Number(owner.pid) <= 0
      )
        throw new Error('授权日志锁损坏；拒绝启动')
      const identity = statSync(this.lockPath)
      try {
        process.kill(Number(owner.pid), 0)
        throw new Error('授权日志已有活动写入者')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      const current = statSync(this.lockPath)
      if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error('授权日志写入者发生变化')
      unlinkSync(this.lockPath)
    }
    const lock = openSync(this.lockPath, 'wx', 0o600)
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid }))
      fsyncSync(lock)
    } finally {
      closeSync(lock)
    }
    try {
      if (existsSync(filename)) {
        if (statSync(filename).size > 67_108_864) throw new Error('授权日志超过安全读取上限，需保留幂等记录并迁移日志')
        const source = readFileSync(filename, 'utf8')
        if (source && !source.endsWith('\n')) throw new Error('授权日志尾部不完整')
        for (const line of source.split('\n').slice(0, -1)) {
          const record = JSON.parse(line) as {
            version: number
            sequence: number
            previous: string
            payload: unknown
            hash: string
          }
          const { hash, ...body } = record
          if (body.version !== journalVersion)
            throw new AuthorizationJournalVersionError(
              `授权日志版本不兼容（当前 ${journalVersion}）；原日志已保留，拒绝猜测旧工具身份或自动重放`,
            )
          if (
            body.sequence !== this.sequence + 1 ||
            body.previous !== this.previous ||
            authorizationDigest(body) !== hash
          )
            throw new Error('授权日志校验失败')
          consume(body.payload)
          this.sequence = body.sequence
          this.previous = hash
        }
      }
      const headPath = `${filename}.head`
      if (existsSync(headPath)) {
        const head = JSON.parse(readFileSync(headPath, 'utf8')) as { sequence?: number; hash?: string }
        if (head.sequence !== this.sequence || head.hash !== this.previous)
          throw new Error('授权日志与持久提交点不匹配')
      } else if (this.sequence !== 0) throw new Error('授权日志缺少持久提交点')
      this.fd = openSync(filename, 'a', 0o600)
      fsyncSync(this.fd)
      this.checkpoint(this.sequence, this.previous)
    } catch (error) {
      if (this.fd !== undefined) closeSync(this.fd)
      this.fd = undefined
      unlinkSync(this.lockPath)
      if (error instanceof AuthorizationJournalVersionError) throw error
      throw new Error('授权日志损坏或不可读；拒绝恢复授权', { cause: error })
    }
  }

  append(payload: unknown) {
    if (this.fd === undefined) throw new Error('授权日志已关闭')
    const body = { version: journalVersion, sequence: this.sequence + 1, previous: this.previous, payload }
    const hash = authorizationDigest(body)
    const line = Buffer.from(`${canonicalAuthorizationJson({ ...body, hash })}\n`)
    try {
      let offset = 0
      while (offset < line.length) {
        const written = writeSync(this.fd, line, offset, line.length - offset)
        if (written <= 0) throw new Error('授权日志没有完成写入')
        offset += written
      }
      fsyncSync(this.fd)
      this.checkpoint(body.sequence, hash)
      this.sequence = body.sequence
      this.previous = hash
    } catch (error) {
      closeSync(this.fd)
      this.fd = undefined
      throw new Error('授权日志写入失败；后续授权已关闭', { cause: error })
    }
  }

  /** Separate commit pointer detects truncation at a valid JSONL record boundary. */
  private checkpoint(sequence: number, hash: string) {
    const temporary = `${this.filename}.head.${randomUUID()}`
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify({ sequence, hash }))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      renameSync(temporary, `${this.filename}.head`)
      if (process.platform !== 'win32') {
        const directory = openSync(path.dirname(this.filename), 'r')
        try {
          fsyncSync(directory)
        } finally {
          closeSync(directory)
        }
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }

  close() {
    if (this.fd !== undefined) closeSync(this.fd)
    this.fd = undefined
    unlinkSync(this.lockPath)
  }
}
