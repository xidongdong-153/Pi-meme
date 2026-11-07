import type { IncomingMessage } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  hostSessionCookiePrefix,
  type BootstrapTicketOptions,
  type TransportIdentity,
} from '@pi-meme/contracts/transport-identity'

export function sessionCookieName(hostId: string) {
  return `${hostSessionCookiePrefix}${createHash('sha256').update(hostId).digest('hex')}`
}

type LoginResult = { status: number; error?: string; cookie?: string; identity?: TransportIdentity }

export function createTransportAuth(options: {
  hostId: string
  hostname: string
  token: string
  tls: boolean
  /** 兼容旧启动参数；本机来源不再授予登录权限。 */
  localAutoLogin?: boolean
}) {
  const cookieName = sessionCookieName(options.hostId)
  const local = ['127.0.0.1', 'localhost', '::1'].includes(options.hostname)
  const protocol = options.tls ? 'https' : 'http'
  const tickets = new Map<string, { expires: number; installationId: string }>()
  const sessions = new Map<string, { expires: number; identity: TransportIdentity }>()
  const prune = () => {
    const now = Date.now()
    for (const [key, value] of tickets) if (value.expires <= now) tickets.delete(key)
    for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key)
  }
  const localRequest = (request: IncomingMessage) => {
    if (!local || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) return false
    try {
      const authority = new URL(`${protocol}://${request.headers.host}`)
      return (
        ['localhost', '127.0.0.1', '[::1]'].includes(authority.hostname) &&
        !authority.username &&
        !authority.password &&
        authority.origin === `${protocol}://${request.headers.host}`
      )
    } catch {
      return false
    }
  }
  const identity = (request: IncomingMessage): TransportIdentity | undefined => {
    const cookie = request.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1)
    const session = cookie ? sessions.get(cookie) : undefined
    if (!session || session.expires <= Date.now()) {
      if (cookie) sessions.delete(cookie)
      return undefined
    }
    return { ...session.identity }
  }
  return {
    authMode: 'token-required' as const,
    localRequest,
    identity,
    authenticated: (request: IncomingMessage) => Boolean(identity(request)),
    allowedSource(request: IncomingMessage) {
      // Origin 防跨站请求；它不是原生 HTTP 调用者的身份证明。
      return (
        (!request.headers.origin || request.headers.origin === `${protocol}://${request.headers.host}`) &&
        (!local || localRequest(request))
      )
    },
    login(request: IncomingMessage, value: { token?: unknown }): LoginResult {
      if (!value || typeof value !== 'object' || (value.token !== undefined && typeof value.token !== 'string'))
        return { status: 401, error: '访问令牌无效' }
      if (!value.token) {
        const current = identity(request)
        return current ? { status: 200, identity: current } : { status: 401, error: '需要访问令牌或已配对的连接' }
      }
      prune()
      const ticket = tickets.get(value.token)
      const tokenMatches =
        Boolean(options.token) &&
        Buffer.byteLength(value.token) === Buffer.byteLength(options.token) &&
        timingSafeEqual(Buffer.from(value.token), Buffer.from(options.token))
      if (!ticket && !tokenMatches) return { status: 401, error: '访问令牌无效或配对票据已失效' }
      if (sessions.size >= 1024) return { status: 429, error: '认证连接过多，请稍后重试' }
      // 消费与建会话都在同一个同步执行段，单次票据不能被并发兑现两次。
      tickets.delete(value.token)
      const installationId = ticket?.installationId ?? randomUUID()
      const authenticatedIdentity: TransportIdentity = {
        principalId: `owner:${options.hostId}`,
        installationId,
        connectionEpoch: randomUUID(),
        role: 'owner',
        hostId: options.hostId,
      }
      const session = randomBytes(32).toString('base64url')
      sessions.set(session, { expires: Date.now() + 24 * 60 * 60 * 1000, identity: authenticatedIdentity })
      return {
        status: 200,
        identity: { ...authenticatedIdentity },
        cookie: `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${options.tls ? '; Secure' : ''}`,
      }
    },
    createBootstrapTicket(input: BootstrapTicketOptions = {}) {
      prune()
      if (tickets.size >= 128) throw new Error('待配对票据过多')
      if (input.installationId !== undefined && !/^[\w-]{16,128}$/.test(input.installationId))
        throw new Error('安装身份无效')
      const value = randomBytes(32).toString('base64url')
      tickets.set(value, { expires: Date.now() + 60000, installationId: input.installationId ?? randomUUID() })
      return value
    },
    dispose() {
      sessions.clear()
      tickets.clear()
    },
  }
}
