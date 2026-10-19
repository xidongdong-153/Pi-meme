import type { IncomingMessage } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function sessionCookieName(hostId: string) {
  return `pi_meme_session_${createHash('sha256').update(hostId).digest('hex')}`
}

export function createTransportAuth(options: {
  hostId: string
  hostname: string
  token: string
  tls: boolean
  localAutoLogin?: boolean
}) {
  const cookieName = sessionCookieName(options.hostId)
  const local = ['127.0.0.1', 'localhost', '::1'].includes(options.hostname)
  const localAutoLogin = Boolean(options.localAutoLogin && local)
  const protocol = options.tls ? 'https' : 'http'
  const tickets = new Map<string, number>()
  const sessions = new Map<string, number>()
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
  const authenticated = (request: IncomingMessage) => {
    const cookie = request.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1)
    const expires = cookie ? sessions.get(cookie) : undefined
    return Boolean(expires && expires > Date.now())
  }
  return {
    localRequest,
    authenticated,
    allowedSource(request: IncomingMessage) {
      return (
        (!request.headers.origin || request.headers.origin === `${protocol}://${request.headers.host}`) &&
        (!localAutoLogin || localRequest(request))
      )
    },
    login(request: IncomingMessage, value: { token?: unknown }) {
      if (value?.token !== undefined && typeof value.token !== 'string') return { status: 401, error: '访问令牌无效' }
      if (value.token) {
        const expires = tickets.get(value.token)
        const ticket = expires !== undefined && expires > Date.now()
        if (
          !ticket &&
          !(
            value.token.length === options.token.length &&
            timingSafeEqual(Buffer.from(value.token), Buffer.from(options.token))
          )
        )
          return { status: 401, error: '访问令牌无效' }
        tickets.delete(value.token)
      } else {
        if (authenticated(request)) return { status: 200 }
        if (!localAutoLogin || !localRequest(request) || !request.headers.origin || request.headers.origin === 'null')
          return { status: 401, error: '需要登录 Host' }
      }
      const session = randomBytes(32).toString('base64url')
      sessions.set(session, Date.now() + 24 * 60 * 60 * 1000)
      return {
        status: 200,
        cookie: `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${options.tls ? '; Secure' : ''}`,
      }
    },
    createBootstrapTicket() {
      const value = randomBytes(32).toString('base64url')
      tickets.set(value, Date.now() + 60000)
      return value
    },
    dispose() {
      sessions.clear()
      tickets.clear()
    },
  }
}
