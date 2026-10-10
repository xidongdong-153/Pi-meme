import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { HostRpcRequest, HostRpcResponse } from '@pi-meme/contracts/host'

/** 写请求 ID 落盘；结果缓存淘汰后明确拒绝重放。读请求不保存快照副本。 */
export class RequestRegistry {
  private readonly requests = new Map<string, { input: string; result: Promise<HostRpcResponse> }>()
  private readonly expired = new Set<string>()
  private readonly completed: string[] = []
  constructor(
    private readonly hostId: string,
    private readonly directory?: string,
    private readonly capacity = 512,
  ) {}
  run(request: HostRpcRequest, action: () => Promise<unknown>, retain = true): Promise<HostRpcResponse> {
    const key = `${request.clientId}:${request.requestId}`
    const input = JSON.stringify([request.method, request.sessionId, request.args])
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
          if (this.expired.has(key)) return error('request-expired', '请求结果已过期，操作没有重新执行')
          if (this.directory) {
            await mkdir(this.directory, { recursive: true })
            try {
              await writeFile(
                path.join(this.directory, createHash('sha256').update(key).digest('hex')),
                createHash('sha256').update(input).digest('hex'),
                { flag: 'wx', mode: 0o600 },
              )
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code === 'EEXIST')
                return error('request-expired', '请求已经接纳，结果已过期；操作没有重新执行')
              throw cause
            }
          }
        }
        const value = await action()
        return { requestId: request.requestId, hostId: this.hostId, result: value }
      })
      .catch((cause: unknown) => error('operation-failed', cause instanceof Error ? cause.message : String(cause)))
    if (retain) {
      this.requests.set(key, { input, result })
      void result.then(() => {
        this.completed.push(key)
        if (this.completed.length > this.capacity) {
          const oldest = this.completed.shift()
          if (oldest !== undefined) {
            this.requests.delete(oldest)
            if (!this.directory) this.expired.add(oldest)
          }
        }
      })
    }
    return result
  }
}
