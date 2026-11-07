import { setTimeout, clearTimeout } from 'node:timers'
import { createHash, randomUUID } from 'node:crypto'
import type { SessionRef } from '@pi-meme/contracts/app-host'
import type { TransportIdentity } from '@pi-meme/contracts/transport-identity'
import type {
  SystemClientClaim,
  SystemClientPermit,
  SystemClientRegistration,
  SystemClientReply,
  SystemClientRequest,
} from '@pi-meme/contracts/system-tools'

type Registration = SystemClientRegistration & { principalId: string; operations: Set<string> }
type Pending = {
  clientId: string
  registration: Registration
  permit: SystemClientPermit
  state: 'issued' | 'claiming' | 'claimed'
  validate: () => void | Promise<void>
  finish: (reply: { result?: unknown; error?: string }) => void
}
function digest(operation: string, args: unknown[], session: SessionRef) {
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
      )
    throw new Error('客户端操作参数不可序列化')
  }
  const body = JSON.stringify([canonical(session), operation, canonical(args)])
  if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('客户端操作参数过大')
  return createHash('sha256').update(body).digest('hex')
}
function sameIdentity(registration: Registration, identity: TransportIdentity) {
  return (
    identity &&
    registration.hostId === identity.hostId &&
    registration.principalId === identity.principalId &&
    registration.installationId === identity.installationId &&
    registration.connectionEpoch === identity.connectionEpoch
  )
}
function publicRegistration(registration: Registration): SystemClientRegistration {
  const { registrationId, documentUUID, installationId, connectionEpoch, hostId } = registration
  return { registrationId, documentUUID, installationId, connectionEpoch, hostId }
}
export class SystemClientBridge {
  private readonly clients = new Map<string, Registration>()
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly publish: (clientId: string, request: SystemClientRequest) => boolean) {}
  register(
    clientId: string,
    operations: unknown,
    identity?: TransportIdentity,
    documentUUID?: string,
  ): SystemClientRegistration {
    if (!identity?.principalId || !identity.installationId || !identity.connectionEpoch || !identity.hostId)
      throw new Error('客户端注册缺少认证身份')
    if (
      typeof documentUUID !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(documentUUID)
    )
      throw new Error('客户端文档标识无效')
    if (!Array.isArray(operations) || operations.length > 32 || operations.some((item) => typeof item !== 'string'))
      throw new Error('客户端能力目录无效')
    const existing = this.clients.get(clientId)
    if (
      existing &&
      sameIdentity(existing, identity) &&
      existing.documentUUID === documentUUID &&
      existing.operations.size === new Set(operations).size &&
      operations.every((operation) => existing.operations.has(operation))
    )
      return publicRegistration(existing)
    this.disconnect(clientId)
    const registration: Registration = {
      registrationId: randomUUID(),
      documentUUID,
      principalId: identity.principalId,
      installationId: identity.installationId,
      connectionEpoch: identity.connectionEpoch,
      hostId: identity.hostId,
      operations: new Set(operations),
    }
    this.clients.set(clientId, registration)
    return publicRegistration(registration)
  }
  unregister(clientId: string, registrationId: string, documentUUID: string, identity: TransportIdentity) {
    const registration = this.clients.get(clientId)
    if (
      !registration ||
      registration.registrationId !== registrationId ||
      registration.documentUUID !== documentUUID ||
      !sameIdentity(registration, identity)
    )
      return
    this.disconnect(clientId)
  }
  supports(clientId: string | undefined, operation: string) {
    return Boolean(clientId && this.clients.get(clientId)?.operations.has(operation))
  }
  async claim(clientId: string, claim: SystemClientClaim, identity: TransportIdentity) {
    const pending = claim && this.pending.get(claim.id)
    if (!pending || pending.clientId !== clientId || pending.state !== 'issued')
      throw new Error('客户端许可不存在或已消费')
    const permit = pending.permit
    const check = () => {
      if (
        this.pending.get(claim.id) !== pending ||
        this.clients.get(clientId) !== pending.registration ||
        !sameIdentity(pending.registration, identity) ||
        permit.deadline <= Date.now() ||
        claim.nonce !== permit.nonce ||
        claim.registrationId !== permit.registrationId ||
        claim.documentUUID !== permit.documentUUID ||
        claim.policyRevision !== permit.policyRevision ||
        digest(claim.operation, claim.args, claim.session) !== permit.argumentsDigest
      )
        throw new Error('客户端许可已失效或目标不匹配')
    }
    check()
    pending.state = 'claiming'
    try {
      await pending.validate()
      check()
      pending.state = 'claimed'
      return { id: claim.id, nonce: permit.nonce, claimedAt: Date.now(), deadline: permit.deadline }
    } catch (cause) {
      pending.finish({ error: '客户端执行授权已失效' })
      throw cause
    }
  }
  reply(clientId: string, reply: SystemClientReply, identity?: TransportIdentity) {
    if (!reply || typeof reply.id !== 'string' || !identity) throw new Error('客户端结果缺少认证或许可')
    const pending = this.pending.get(reply.id)
    if (!pending) throw new Error('客户端结果许可已失效')
    if (
      pending.clientId !== clientId ||
      !sameIdentity(pending.registration, identity) ||
      this.clients.get(clientId) !== pending.registration ||
      reply.nonce !== pending.permit.nonce ||
      reply.registrationId !== pending.permit.registrationId ||
      pending.permit.deadline <= Date.now()
    )
      throw new Error('客户端结果来源或许可不匹配')
    if (pending.state !== 'claimed' && !reply.error) throw new Error('客户端操作尚未领取执行许可')
    pending.finish(reply)
  }
  request(
    clientId: string | undefined,
    session: SessionRef,
    operation: string,
    args: unknown[],
    signal: AbortSignal,
    authorization?: { policyRevision: string; validate: () => void | Promise<void> },
  ) {
    signal.throwIfAborted()
    const registration = clientId ? this.clients.get(clientId) : undefined
    if (!clientId || !registration?.operations.has(operation)) throw new Error('发起客户端未连接或不支持此操作')
    if (!authorization?.policyRevision || typeof authorization.validate !== 'function')
      throw new Error('客户端操作缺少执行授权')
    if (session.hostId !== registration.hostId) throw new Error('客户端会话Host不匹配')
    if (
      this.pending.size >= 256 ||
      [...this.pending.values()].filter((item) => item.clientId === clientId).length >= 32
    )
      throw new Error('客户端待处理操作过多')
    const id = randomUUID()
    const permit: SystemClientPermit = {
      ...publicRegistration(registration),
      nonce: randomUUID(),
      policyRevision: authorization.policyRevision,
      argumentsDigest: digest(operation, args, session),
      session,
      deadline: Date.now() + 30_000,
    }
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const finish = (reply: { result?: unknown; error?: string }) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.pending.delete(id)
        if (reply.error) reject(new Error(reply.error))
        else resolve(reply.result)
      }
      function abort() {
        finish({ error: '客户端操作已取消；已领取的操作结果可能不确定，请先查询状态' })
      }
      function expire() {
        finish({ error: '客户端操作超时；已领取的操作结果不确定，请先查询状态' })
      }
      timer = setTimeout(expire, 30_000)
      this.pending.set(id, {
        clientId,
        registration,
        permit,
        state: 'issued',
        validate: async () => {
          signal.throwIfAborted()
          await authorization.validate()
          signal.throwIfAborted()
        },
        finish,
      })
      signal.addEventListener('abort', abort, { once: true })
      try {
        if (!this.publish(clientId, { id, operation, args, session, deadline: permit.deadline, permit }))
          finish({ error: '发起客户端已离线' })
      } catch {
        finish({ error: '客户端请求发送失败' })
      }
    })
  }
  disconnect(clientId: string, identity?: TransportIdentity) {
    const registration = this.clients.get(clientId)
    if (identity && (!registration || !sameIdentity(registration, identity))) return
    this.clients.delete(clientId)
    for (const pending of this.pending.values())
      if (pending.clientId === clientId) pending.finish({ error: '客户端断线，已领取操作的结果不确定' })
  }
}
