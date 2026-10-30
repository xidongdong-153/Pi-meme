import { setTimeout, clearTimeout } from 'node:timers'
import { randomUUID } from 'node:crypto'
import type { SessionRef } from '@pi-meme/contracts/app-host'
import type { SystemClientReply, SystemClientRequest } from '@pi-meme/contracts/system-tools'

export class SystemClientBridge {
  private readonly clients = new Map<string, Set<string>>()
  private readonly pending = new Map<string, { clientId: string; finish: (reply: SystemClientReply) => void }>()
  constructor(private readonly publish: (clientId: string, request: SystemClientRequest) => boolean) {}
  register(clientId: string, operations: unknown) {
    if (!Array.isArray(operations) || operations.length > 32 || operations.some((item) => typeof item !== 'string'))
      throw new Error('客户端能力目录无效')
    this.clients.set(clientId, new Set(operations))
  }
  supports(clientId: string | undefined, operation: string) {
    return Boolean(clientId && this.clients.get(clientId)?.has(operation))
  }
  reply(clientId: string, reply: SystemClientReply) {
    if (!reply || typeof reply.id !== 'string') throw new Error('客户端结果参数无效')
    const pending = this.pending.get(reply.id)
    if (!pending) return
    if (pending.clientId !== clientId) throw new Error('客户端结果来源不匹配')
    pending.finish(reply)
  }
  request(clientId: string | undefined, session: SessionRef, operation: string, args: unknown[], signal: AbortSignal) {
    signal.throwIfAborted()
    if (!clientId || !this.clients.get(clientId)?.has(operation)) throw new Error('发起客户端未连接或不支持此操作')
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const pending = this.pending
      let timer: number | NodeJS.Timeout
      function finish(reply: SystemClientReply) {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        pending.delete(id)
        if (reply.error) reject(new Error(reply.error))
        else resolve(reply.result)
      }
      function abort() {
        finish({ id, error: '客户端操作已取消；已发送的操作可能已经执行，请先查询状态' })
      }
      timer = setTimeout(finish, 30_000, { id, error: '客户端操作超时，结果不确定；请先查询状态，不要直接重试写操作' })
      this.pending.set(id, { clientId, finish })
      signal.addEventListener('abort', abort, { once: true })
      if (!this.publish(clientId, { id, operation, args, session, deadline: Date.now() + 30_000 }))
        finish({ id, error: '发起客户端已离线' })
    })
  }
  disconnect(clientId: string) {
    this.clients.delete(clientId)
    for (const [id, pending] of this.pending)
      if (pending.clientId === clientId) pending.finish({ id, error: '客户端断线，操作结果不确定' })
  }
}
