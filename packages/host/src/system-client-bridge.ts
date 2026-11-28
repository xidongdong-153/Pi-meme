import { setTimeout, clearTimeout } from 'node:timers'
import { browserAgentOperations } from '@pi-meme/contracts/browser-agent'
import { computerOperations } from '@pi-meme/contracts/computer-use'
import { randomUUID } from 'node:crypto'
import type { SessionRef } from '@pi-meme/contracts/app-host'
import type {
  SystemClientIdentity,
  SystemClientRegistration,
  SystemClientReply,
  SystemClientRequest,
} from '@pi-meme/contracts/system-tools'
import { clientReadDefinitions } from '@pi-meme/contracts/system-client-reads'
import { visualizationClientOperationDefinitions } from '@pi-meme/contracts/visualize'
import {
  readRecord,
  SystemReadError,
  type ReadErrorCode,
  type SystemReadErrorDetails,
} from '@pi-meme/contracts/system-read'

const readErrorCodes = new Set<ReadErrorCode>([
  'invalid-input',
  'not-found',
  'not-supported',
  'not-loaded',
  'disabled',
  'disconnected',
  'permission-denied',
  'stale-cursor',
  'cancelled',
  'timeout',
  'internal-error',
])

const allowed = new Set([
  ...browserAgentOperations.map((op) => op.name),
  ...computerOperations.map((op) => op.name),
  ...clientReadDefinitions.map((definition) => definition.name),
  ...visualizationClientOperationDefinitions.map((definition) => definition.name),
  'appearance.get',
  'appearance.save',
  'browser.list',
  'browser.screenshot',
  'browser.open',
  'browser.navigate',
  'browser.close',
])
function validIdentity(value: unknown): value is SystemClientIdentity {
  if (!value || typeof value !== 'object') return false
  const identity = value as SystemClientIdentity
  return (
    [identity.connectionId, identity.registrationId].every(
      (id) => typeof id === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(id),
    ) &&
    Number.isSafeInteger(identity.documentGeneration) &&
    identity.documentGeneration >= 1
  )
}
function same(a: SystemClientIdentity, b: SystemClientIdentity) {
  return (
    a.connectionId === b.connectionId &&
    a.registrationId === b.registrationId &&
    a.documentGeneration === b.documentGeneration
  )
}
export class SystemClientBridge {
  private readonly clients = new Map<string, SystemClientRegistration>()
  private readonly pending = new Map<
    string,
    {
      clientId: string
      identity: SystemClientIdentity
      finish: (
        result?: unknown,
        error?: string,
        errorCode?: ReadErrorCode,
        errorDetails?: SystemReadErrorDetails,
      ) => void
    }
  >()
  constructor(private readonly publish: (clientId: string, request: SystemClientRequest) => boolean) {}
  identity(clientId: string | undefined): SystemClientIdentity | undefined {
    const client = clientId ? this.clients.get(clientId) : undefined
    return client
      ? {
          connectionId: client.connectionId,
          registrationId: client.registrationId,
          documentGeneration: client.documentGeneration,
        }
      : undefined
  }
  matches(clientId: string | undefined, identity: SystemClientIdentity | undefined) {
    const current = this.identity(clientId)
    return Boolean(current && identity && same(current, identity))
  }
  register(clientId: string, value: unknown) {
    if (!validIdentity(value)) throw new Error('客户端注册身份无效')
    const registration = value as SystemClientRegistration
    if (
      !Array.isArray(registration.operations) ||
      registration.operations.length > allowed.size ||
      registration.operations.some((name) => typeof name !== 'string' || !allowed.has(name))
    )
      throw new Error('客户端能力目录无效')
    const previous = this.clients.get(clientId)
    if (previous && previous.connectionId !== registration.connectionId)
      throw new Error('此客户端已有其他连接注册，不能接管其操作')
    if (previous && !same(previous, registration)) this.disconnect(clientId, previous.connectionId)
    this.clients.set(clientId, { ...registration, operations: [...new Set(registration.operations)] })
  }
  unregister(clientId: string, identity: unknown) {
    if (!validIdentity(identity)) throw new Error('客户端注销身份无效')
    if (this.matches(clientId, identity)) this.disconnect(clientId, identity.connectionId)
  }
  supports(clientId: string | undefined, operation: string) {
    return Boolean(clientId && this.clients.get(clientId)?.operations.includes(operation))
  }
  reply(clientId: string, reply: SystemClientReply) {
    if (!validIdentity(reply) || typeof reply.id !== 'string') throw new Error('客户端结果参数无效')
    const pending = this.pending.get(reply.id)
    if (!pending) return
    if (pending.clientId !== clientId || !same(pending.identity, reply) || !this.matches(clientId, reply))
      throw new Error('客户端结果来源或注册代次不匹配')
    if (reply.error !== undefined && typeof reply.error !== 'string') throw new Error('客户端错误结果无效')
    const code = (reply as SystemClientReply & { errorCode?: unknown }).errorCode
    if (code !== undefined && (typeof code !== 'string' || !readErrorCodes.has(code as ReadErrorCode)))
      throw new Error('客户端读取错误码无效')
    if (reply.errorDetails !== undefined) {
      const details = readRecord(
        reply.errorDetails,
        ['nativeCode', 'phase', 'reason', 'delivery', 'retry', 'recovery'],
        '客户端错误详情',
      )
      if (
        !code ||
        !reply.error ||
        Object.values(details).some((value) => typeof value !== 'string' || value.length > 500)
      )
        throw new Error('客户端错误详情无效')
    }
    pending.finish(reply.result, reply.error, code as ReadErrorCode | undefined, reply.errorDetails)
  }
  endComputer(clientId: string, session: SessionRef, identity: SystemClientIdentity, executionId: string) {
    if (this.matches(clientId, identity))
      this.publish(clientId, {
        ...identity,
        id: randomUUID(),
        operation: 'computer.end',
        args: [],
        session,
        executionId,
        deadline: Date.now() + 30000,
      })
  }
  isPending(clientId: string, id: string, identity: SystemClientIdentity) {
    const pending = this.pending.get(id)
    return Boolean(
      pending && pending.clientId === clientId && same(pending.identity, identity) && this.matches(clientId, identity),
    )
  }
  request(
    clientId: string | undefined,
    session: SessionRef,
    operation: string,
    args: unknown[],
    signal: AbortSignal,
    executionId?: string,
  ) {
    signal.throwIfAborted()
    const identity = this.identity(clientId)
    if (!clientId || !identity || !this.supports(clientId, operation)) throw new Error('发起客户端未连接或不支持此操作')
    const timeout = executionId
      ? 90_000
      : operation === 'browser.waitFor' || operation === 'browser.batch'
        ? 60_000
        : 30_000
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      const finish = (
        result?: unknown,
        error?: string,
        errorCode?: ReadErrorCode,
        errorDetails?: SystemReadErrorDetails,
      ) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.pending.delete(id)
        if (error) reject(errorCode ? new SystemReadError(errorCode, error, errorDetails) : new Error(error))
        else resolve(result)
      }
      function abort() {
        finish(undefined, '客户端操作已取消；已发送的操作可能已经执行，请先查询状态', 'cancelled')
      }
      timer = setTimeout(
        finish,
        timeout,
        undefined,
        '客户端操作超时，结果不确定；请先查询状态，不要直接重试写操作',
        'timeout',
      )
      this.pending.set(id, { clientId, identity, finish })
      signal.addEventListener('abort', abort, { once: true })
      if (
        !this.publish(clientId, {
          id,
          operation,
          args,
          session,
          ...identity,
          executionId,
          deadline: Date.now() + timeout,
        })
      )
        finish(undefined, '发起客户端已离线', 'disconnected')
    })
  }
  disconnect(clientId: string, connectionId?: string) {
    const client = this.clients.get(clientId)
    if (client && (!connectionId || client.connectionId === connectionId)) this.clients.delete(clientId)
    for (const pending of this.pending.values())
      if (pending.clientId === clientId && (!connectionId || pending.identity.connectionId === connectionId))
        pending.finish(undefined, '客户端断线或注册已失效，操作结果不确定', 'disconnected')
  }
}
