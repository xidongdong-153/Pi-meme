import { createHash, randomUUID } from 'node:crypto'
import {
  readRecord,
  readString,
  readText,
  systemReadTextByteLimit,
  SystemReadError,
} from '@pi-meme/contracts/system-read'

type RetainedResult = {
  identity: string
  operation: string
  args: unknown[]
  content: string
  revision: string
  sourceRevision?: string
  expires: number
}

function sourceRevision(result: unknown): string | undefined {
  if (typeof result === 'string') return createHash('sha256').update(result).digest('hex')
  if (!result || typeof result !== 'object') return undefined
  const value = result as { revision?: unknown; branchRevision?: unknown }
  const revision = value.branchRevision ?? value.revision
  return typeof revision === 'string' || typeof revision === 'number' ? String(revision) : undefined
}

/** Bounded, execution-scoped snapshots. No result is written to disk. */
export class SystemReadResults {
  private readonly retained = new Map<string, RetainedResult>()
  private readonly maxBytes = 64 * 1024 * 1024

  private prune() {
    for (const [id, value] of this.retained) if (value.expires <= Date.now()) this.retained.delete(id)
  }

  capture(identity: string, operation: string, args: unknown[], result: unknown): unknown {
    if (result && typeof result === 'object') {
      const image = result as { type?: unknown; dataUrl?: unknown }
      if (image.type === 'image' || (typeof image.dataUrl === 'string' && image.dataUrl.startsWith('data:image/')))
        return result
    }
    const content = JSON.stringify(result ?? null)
    const size = Buffer.byteLength(content, 'utf8')
    if (size <= systemReadTextByteLimit) return result
    this.prune()
    if (size > this.maxBytes)
      throw new SystemReadError('invalid-input', '结果超过保留预算，请使用目录中的业务分页或正文分片入口缩小查询')
    let retainedBytes = [...this.retained.values()].reduce((sum, value) => sum + Buffer.byteLength(value.content), 0)
    while (this.retained.size >= 32 || retainedBytes + size > this.maxBytes) {
      const oldest = this.retained.keys().next().value
      if (oldest === undefined) break
      retainedBytes -= Buffer.byteLength(this.retained.get(oldest)!.content)
      this.retained.delete(oldest)
    }
    const id = randomUUID()
    const value: RetainedResult = {
      identity,
      operation,
      args: structuredClone(args),
      content,
      revision: createHash('sha256').update(content).digest('hex'),
      sourceRevision: sourceRevision(result),
      expires: Date.now() + 5 * 60_000,
    }
    this.retained.set(id, value)
    return this.piece(id, value, {})
  }

  private piece(id: string, value: RetainedResult, query: { offset?: number; limit?: number; revision?: string }) {
    const piece = readText(value.content, query, value.revision)
    return {
      ...piece,
      format: 'json',
      resultId: id,
      sourceOperation: value.operation,
      consistency: value.sourceRevision === undefined ? 'retained-snapshot' : 'revision',
      truncated: piece.nextOffset !== undefined,
      expiresAt: new Date(value.expires).toISOString(),
      continuation:
        piece.nextOffset === undefined
          ? undefined
          : {
              operation: 'results.read',
              args: [{ id, revision: value.revision, offset: piece.nextOffset, limit: query.limit ?? 12_000 }],
            },
    }
  }

  async read(identity: string, input: unknown, authorize: (operation: string, args: unknown[]) => Promise<unknown>) {
    const query = readRecord(input, ['id', 'revision', 'offset', 'limit'])
    const id = readString(query.id, '读取结果标识', 128)
    const revision = readString(query.revision, '读取结果修订', 128)
    this.prune()
    const value = this.retained.get(id)
    if (!value || value.identity !== identity || value.revision !== revision)
      throw new SystemReadError('stale-cursor', '读取结果已过期或不属于当前执行，请重新调用原读取操作')
    // Revalidate the original operation and target on every piece, including after permission revocation.
    const current = await authorize(value.operation, structuredClone(value.args))
    if (value.sourceRevision !== undefined && sourceRevision(current) !== value.sourceRevision) {
      this.retained.delete(id)
      throw new SystemReadError('stale-cursor', '原始数据已变化，请重新调用原读取操作')
    }
    return this.piece(id, value, {
      revision,
      offset: query.offset as number | undefined,
      limit: query.limit as number | undefined,
    })
  }

  clear() {
    this.retained.clear()
  }
}
