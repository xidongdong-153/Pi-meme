import type { Session } from 'electron'
import { sessionCookieName } from '@pi-meme/host/transport-auth'
import { businessRequestHeaders, businessResponseHeaders } from './browser/browser-policy'

type CookieSession = Pick<Session, 'cookies'>
type AuthenticationState = {
  revision: object
  queue: Promise<void>
  controllers: Set<AbortController>
}
const pairedOrigins = new WeakMap<object, Map<string, string>>()
const ownerCookieScopes = new WeakMap<object, { names: ReadonlySet<string>; origins: ReadonlySet<string> }>()
const protectedSessions = new WeakSet<object>()
const authentications = new WeakMap<object, AuthenticationState>()

export class HostIdentityChangedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostIdentityChangedError'
  }
}

function authenticationState(session: CookieSession) {
  let state = authentications.get(session)
  if (!state) {
    state = { revision: {}, queue: Promise.resolve(), controllers: new Set() }
    authentications.set(session, state)
  }
  return state
}

function ownerCookieNames(session: Session, value: string) {
  const scope = ownerCookieScopes.get(session)
  if (!scope) return undefined
  try {
    const url = new URL(value)
    if (url.protocol === 'ws:') url.protocol = 'http:'
    if (url.protocol === 'wss:') url.protocol = 'https:'
    return scope.origins.has(url.origin) ? scope.names : undefined
  } catch {
    return undefined
  }
}

function localFrontend(value: string) {
  const address = new URL(value)
  if (
    address.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) ||
    address.username ||
    address.password
  )
    throw new Error('Owner Cookie 只允许绑定无凭据的本机前端')
  return address
}

/** Main UI subresources must not carry its Host cookie to another same-hostname port. */
export function protectOwnerSessionCookies(session: Session) {
  if (protectedSessions.has(session)) return
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: businessRequestHeaders(details.requestHeaders, ownerCookieNames(session, details.url)) })
  })
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: businessResponseHeaders(details.responseHeaders ?? {}, ownerCookieNames(session, details.url)),
    })
  })
  protectedSessions.add(session)
}

export function bindOwnerCookieScope(session: Session, hostId: string, apiUrl: string, frontendUrl: string) {
  const name = sessionCookieName(hostId)
  const api = new URL(apiUrl)
  const frontend = localFrontend(frontendUrl)
  if (pairedOrigins.get(session)?.get(name) !== api.origin) throw new Error('Owner Cookie 缺少已认证的服务绑定')
  ownerCookieScopes.set(session, { names: new Set([name]), origins: new Set([api.origin, frontend.origin]) })
}

export function clearOwnerCookieScope(session: CookieSession) {
  ownerCookieScopes.delete(session)
  pairedOrigins.delete(session)
  const state = authenticationState(session)
  state.revision = {}
  for (const controller of state.controllers)
    controller.abort(new HostIdentityChangedError('服务认证已失效，请重新连接'))
}

/** The caller has a deadline; the queue still waits for real Cookie writes to settle before admitting another. */
function authenticationResult<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void pending.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

function authenticateHost(
  session: CookieSession,
  address: URL,
  token: string,
  expectedHostId?: string,
  frontendUrl?: string,
): Promise<string> {
  const frontend = frontendUrl ? localFrontend(frontendUrl) : undefined
  const state = authenticationState(session)
  if (state.controllers.size >= 8) return Promise.reject(new Error('认证正在等待旧操作结束，请稍后重试'))
  const revision = state.revision
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])
  state.controllers.add(controller)
  function assertActive() {
    if (state.revision !== revision) throw new HostIdentityChangedError('服务认证已失效，请重新连接')
    signal.throwIfAborted()
  }
  function rejectIdentity(message: string): never {
    if (state.revision === revision) clearOwnerCookieScope(session)
    throw new HostIdentityChangedError(message)
  }
  const pending = state.queue.then(async () => {
    try {
      assertActive()
      const origins = new Map(pairedOrigins.get(session))
      const expectedName = expectedHostId && sessionCookieName(expectedHostId)
      // Cookie jars are hostname-scoped, not port-scoped. Reuse only this Host's cookie at its paired origin.
      const cookie =
        !token && expectedName && origins.get(expectedName) === address.origin
          ? (await session.cookies.get({ url: address.origin, name: expectedName }))[0]
          : undefined
      assertActive()
      const response = await fetch(`${address.origin}/api/auth`, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Origin: address.origin,
          ...(cookie ? { Cookie: `${cookie.name}=${cookie.value}` } : {}),
        },
        body: JSON.stringify({ token }),
      })
      assertActive()
      if (!response.ok) {
        await response.body?.cancel()
        assertActive()
        throw new Error('服务认证失败，请重新输入访问令牌')
      }
      let value: unknown
      const reader = response.body?.getReader()
      if (!reader) rejectIdentity('服务没有返回有效身份，请重新连接')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const next = await reader.read()
          assertActive()
          if (next.done) break
          size += next.value.byteLength
          if (size > 65536) {
            await reader.cancel()
            assertActive()
            rejectIdentity('服务身份响应超过安全上限，请重新连接')
          }
          chunks.push(next.value)
        }
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        assertActive()
        if (error instanceof HostIdentityChangedError) throw error
        rejectIdentity('服务没有返回有效身份，请重新连接')
      } finally {
        reader.releaseLock()
      }
      assertActive()
      if (
        !value ||
        typeof value !== 'object' ||
        !('hostId' in value) ||
        typeof value.hostId !== 'string' ||
        !value.hostId ||
        value.hostId.length > 512 ||
        value.hostId.includes('\0')
      )
        rejectIdentity('服务没有返回有效身份，请重新连接')
      if (expectedHostId && value.hostId !== expectedHostId) rejectIdentity('服务身份已变化，请重新连接并配对')
      const name = sessionCookieName(value.hostId)
      const issued = response.headers.getSetCookie().find((line) => line.slice(0, line.indexOf('=')).trim() === name)
      let expiration: number | undefined
      let cookieValue: string
      if (issued) {
        const [pair, ...attributes] = issued.split(';')
        const maxAge = attributes.find((item) => item.trim().toLowerCase().startsWith('max-age='))
        const expires = attributes.find((item) => item.trim().toLowerCase().startsWith('expires='))
        expiration = maxAge
          ? Date.now() / 1000 + Number(maxAge.trim().slice(8))
          : expires
            ? Date.parse(expires.trim().slice(8)) / 1000
            : undefined
        cookieValue = pair.slice(pair.indexOf('=') + 1)
      } else if (cookie) {
        cookieValue = cookie.value
        expiration = cookie.expirationDate
      } else rejectIdentity('服务没有返回配对 Cookie，请重新连接')
      if (!cookieValue) rejectIdentity('服务没有返回有效的配对 Cookie，请重新连接')
      const setCookie = async (target: URL) => {
        assertActive()
        await session.cookies.set({
          url: target.origin,
          name,
          value: cookieValue,
          path: '/',
          httpOnly: true,
          sameSite: 'strict',
          secure: target.protocol === 'https:',
          ...(expiration !== undefined && Number.isFinite(expiration) ? { expirationDate: expiration } : {}),
        })
        assertActive()
      }
      if (issued) await setCookie(address)
      if (frontend && frontend.hostname !== address.hostname) await setCookie(frontend)
      assertActive()
      origins.set(name, address.origin)
      pairedOrigins.set(session, origins)
      return value.hostId
    } finally {
      state.controllers.delete(controller)
    }
  })
  state.queue = pending.then(
    () => {},
    () => {},
  )
  return authenticationResult(pending, signal)
}

export function authenticateRemoteHost(session: CookieSession, url: string, token: string, expectedHostId?: string) {
  const address = new URL(url)
  if (address.protocol !== 'https:' || address.username || address.password)
    throw new Error('远程服务必须使用 HTTPS，地址不能包含凭据')
  return authenticateHost(session, address, token, expectedHostId)
}

/** 只有 Desktop main 能为已核对身份的本机服务消费私有票据或用户显式输入的令牌。 */
export function authenticateLocalHost(
  session: CookieSession,
  url: string,
  token: string,
  expectedHostId: string,
  frontendUrl?: string,
) {
  const address = new URL(url)
  if (
    address.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) ||
    address.username ||
    address.password
  )
    throw new Error('本机服务必须使用 loopback 地址')
  return authenticateHost(session, address, token, expectedHostId, frontendUrl)
}
