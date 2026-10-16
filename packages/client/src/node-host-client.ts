import type { EventCursor, HostApi, HostControlEvent, HostControlResponse } from '@pi-meme/contracts/app-host'
import type { HostRpcResponse } from '@pi-meme/contracts/host'
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
export type NodeHostClient = HostApi & {
  rpc: <T>(method: string, args?: unknown[]) => Promise<T>
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
    throw new Error('远程 Host 必须使用不含账号信息的 HTTPS 地址')
  let hostId = options.hostId
  let cookie = ''
  let authentication: Promise<void> | undefined
  let disposed = false
  const closers = new Set<() => void>()
  const authenticate = () => {
    authentication ??= (async () => {
      const response = await request(new URL('/api/auth', options.url), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', Origin: baseUrl.origin },
        body: JSON.stringify({ token: options.token }),
      })
      if (!response.ok) throw new Error('Host 登录失败')
      const identity = (await response.json()) as { hostId: string }
      if (!identity.hostId || (hostId && hostId !== identity.hostId)) throw new Error('Host 身份已变化')
      hostId = identity.hostId
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
      if (!cookie) throw new Error('Host 没有返回认证 Cookie')
    })().finally(() => {
      authentication = undefined
    })
    return authentication
  }
  await authenticate()
  async function call<T>(pathname: '/api/control' | '/api/rpc', input: Record<string, unknown>): Promise<T> {
    if (disposed) throw new Error('Host 客户端已关闭')
    const body = JSON.stringify({ ...input, hostId, clientId: options.clientId })
    const send = () =>
      request(new URL(pathname, options.url), {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: baseUrl.origin },
        body,
      })
    let response = await send()
    if (response.status === 401) {
      await authenticate()
      if (disposed) throw new Error('Host 客户端已关闭')
      response = await send()
    }
    const value = (await response.json()) as HostControlResponse | HostRpcResponse
    if (!response.ok) {
      const error: unknown = value.error
      throw new Error(typeof error === 'string' ? error : `Host 请求失败：${response.status}`)
    }
    if (value.hostId !== hostId) throw new Error('Host 身份已变化')
    if (pathname === '/api/rpc' && (!('requestId' in value) || value.requestId !== input.requestId))
      throw new Error('Host 返回了不匹配的请求标识')
    if (value.error) throw Object.assign(new Error(value.error.message), { code: value.error.code })
    return value.result as T
  }
  const api = createAppHostClient({
    call: <T>(method: string, args: unknown[], idempotencyKey?: string) =>
      call<T>('/api/control', { apiVersion: 2, method, args, idempotencyKey }),
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
    rpc: <T>(method: string, args: unknown[] = []) =>
      call<T>('/api/rpc', { requestId: crypto.randomUUID(), method, args }),
    dispose() {
      disposed = true
      for (const close of [...closers]) close()
    },
  })
}
