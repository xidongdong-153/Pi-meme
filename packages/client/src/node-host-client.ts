import type { EventCursor, HostApi, HostControlEvent, HostControlResponse } from '@pi-meme/contracts/app-host'
import { isHostRpcResponse } from '@pi-meme/contracts/host'
import type { AppUpdateCheck } from '@pi-meme/contracts/app-update'
import { createAppHostClient } from './app-host-client'

export type NodeHostClientOptions = {
  url: string
  token: string
  hostId?: string
  clientId: string
  fetch?: typeof fetch
  webSocket?: (
    url: string,
    headers: Record<string, string>,
  ) => {
    on: ((event: 'message', callback: (data: { toString: () => string }) => void) => unknown) &
      ((event: 'close', callback: () => void) => unknown) &
      ((event: 'error', callback: () => void) => unknown)
    close: () => void
  }
}
type RpcOptions = { sessionId?: string; signal?: AbortSignal; requestId?: string }
export type NodeHostClient = HostApi & {
  checkAppUpdate: (force?: boolean) => Promise<AppUpdateCheck>
  rpc: <T>(method: string, args?: unknown[], options?: RpcOptions) => Promise<T>
  dispose: () => void
}

export async function createNodeHostClient(options: NodeHostClientOptions): Promise<NodeHostClient> {
  const request = options.fetch ?? fetch
  const baseUrl = new URL(options.url)
  if (
    baseUrl.username ||
    baseUrl.password ||
    (baseUrl.protocol !== 'https:' &&
      !(baseUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname)))
  )
    throw new Error('远程服务必须使用不含账号信息的 HTTPS 地址')
  let hostId = options.hostId
  let cookie = ''
  let authentication: Promise<void> | undefined
  let disposed = false
  const lifetime = new AbortController()
  const closers = new Set<() => void>()
  const authenticate = () => {
    authentication ??= (async () => {
      const response = await request(new URL('/api/auth', options.url), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(30000), lifetime.signal]),
        headers: { 'Content-Type': 'application/json', Origin: baseUrl.origin },
        body: JSON.stringify({ token: options.token }),
      })
      if (!response.ok) throw new Error('服务登录失败')
      const identity = (await response.json()) as { hostId: string }
      if (!identity.hostId || (hostId && hostId !== identity.hostId)) throw new Error('服务身份已变化')
      hostId = identity.hostId
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
      if (!cookie) throw new Error('服务没有返回认证 Cookie')
    })().finally(() => {
      authentication = undefined
    })
    return authentication
  }
  await authenticate()
  async function call<T>(
    pathname: '/api/control' | '/api/rpc' | '/api/update/check',
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (disposed) throw new Error('服务客户端已关闭')
    const activeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    activeSignal.throwIfAborted()
    const body = JSON.stringify({ ...input, hostId, clientId: options.clientId })
    const send = () =>
      request(new URL(pathname, options.url), {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: baseUrl.origin },
        body,
        signal: activeSignal,
      })
    let response = await send()
    activeSignal.throwIfAborted()
    if (response.status === 401) {
      await authenticate()
      if (disposed) throw new Error('服务客户端已关闭')
      response = await send()
    }
    const value: unknown = await response.json()
    activeSignal.throwIfAborted()
    if (!response.ok) {
      const error = value && typeof value === 'object' && 'error' in value ? value.error : undefined
      throw new Error(typeof error === 'string' ? error : `服务请求失败：${response.status}`)
    }
    if (pathname === '/api/rpc') {
      if (!isHostRpcResponse(value)) throw new Error('服务回执格式无效')
      if (value.requestId !== input.requestId) throw new Error('服务返回了不匹配的请求标识')
    }
    const reply = value as HostControlResponse
    if (!reply || reply.hostId !== hostId) throw new Error('服务身份已变化')
    if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code })
    return reply.result as T
  }
  const api = createAppHostClient({
    call: <T>(method: string, args: unknown[], idempotencyKey?: string) =>
      call<T>('/api/control', { method, args, idempotencyKey }),
    async subscribe(input, listener) {
      const webSocket = options.webSocket
      if (!webSocket) throw new Error('此 Node 客户端未配置 WebSocket')
      let stopped = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let socket: ReturnType<NonNullable<NodeHostClientOptions['webSocket']>> | undefined
      let after: EventCursor | undefined = input.after
      async function connect() {
        if (stopped || disposed) return
        await authenticate()
        if (stopped || disposed) return
        const url = new URL('/api/control/events', options.url)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.searchParams.set('clientId', options.clientId)
        url.searchParams.set('subscription', JSON.stringify({ ...input, after }))
        socket = webSocket!(url.toString(), { Cookie: cookie, Origin: baseUrl.origin })
        socket.on('message', (data) => {
          let event: HostControlEvent
          try {
            event = JSON.parse(data.toString()) as HostControlEvent
          } catch {
            socket?.close()
            return
          }
          if (event.hostId !== hostId) {
            stopped = true
            socket?.close()
            return
          }
          if (
            event.stream !== 'live' &&
            event.type !== 'resync' &&
            after?.journalEpoch === event.journalEpoch &&
            after.seq >= event.seq
          )
            return
          if (event.stream !== 'live') after = { journalEpoch: event.journalEpoch, seq: event.seq }
          listener(event)
        })
        socket.on('error', () => socket?.close())
        socket.on('close', () => {
          if (!stopped && !disposed)
            timer = setTimeout(() => {
              void connect().catch(schedule)
            }, 1000)
        })
      }
      function schedule() {
        if (!stopped && !disposed)
          timer = setTimeout(() => {
            void connect().catch(schedule)
          }, 1000)
      }
      await connect()
      const close = () => {
        stopped = true
        if (timer) clearTimeout(timer)
        socket?.close()
        closers.delete(close)
      }
      closers.add(close)
      return close
    },
  })
  return Object.assign(api, {
    checkAppUpdate: (force = false) => call<AppUpdateCheck>('/api/update/check', { force }, AbortSignal.timeout(20000)),
    rpc: <T>(
      method: string,
      args: unknown[] = [],
      { sessionId, signal, requestId = crypto.randomUUID() }: RpcOptions = {},
    ) => call<T>('/api/rpc', { requestId, method, args, sessionId }, signal),
    dispose() {
      disposed = true
      lifetime.abort()
      for (const close of [...closers]) close()
    },
  })
}
