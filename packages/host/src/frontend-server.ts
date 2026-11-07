import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable, type Duplex } from 'node:stream'
import { createAdaptorServer, type HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import {
  controlPlaneResponseHeader,
  controlPlaneResponseValue,
  hostSessionCookiePrefix,
} from '@pi-meme/contracts/transport-identity'
import { visualizationPreviewPath } from '@pi-meme/visualize/server/preview-page'
import { serveFrontend } from './frontend'
import { realpath } from 'node:fs/promises'
import { readRuntimeSnapshot } from './runtime-snapshot'
import { assertLocalHostUrl, waitForLocalHost } from './host-status'
import { sessionCookieName } from './transport-auth'

function fetchLocal(request: Request): Promise<Response> {
  return new Promise((resolve, reject) => {
    const send = new URL(request.url).protocol === 'https:' ? httpsRequest : httpRequest
    const pending = send(
      request.url,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        signal: request.signal,
      },
      (response) => {
        const headers = new Headers()
        for (let index = 0; index < response.rawHeaders.length; index += 2)
          headers.append(response.rawHeaders[index], response.rawHeaders[index + 1])
        const status = response.statusCode ?? 502
        const body =
          request.method === 'HEAD' || [204, 205, 304].includes(status)
            ? null
            : (Readable.toWeb(response) as ReadableStream<Uint8Array>)
        resolve(new Response(body, { status, headers }))
      },
    )
    pending.once('error', reject)
    if (request.body)
      Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0])
        .on('error', (cause) => pending.destroy(cause))
        .pipe(pending)
    else pending.end()
  })
}

export async function startFrontendServer(options: {
  upstreamUrl: string
  hostId: string
  staticDirectory: string
  port?: number
  readinessTimeoutMs?: number
  runtimeSnapshotRoot?: string
}) {
  const snapshotRoot = options.runtimeSnapshotRoot ?? process.env.PI_MEME_RUNTIME_SNAPSHOT
  if (snapshotRoot) {
    const snapshot = await readRuntimeSnapshot(snapshotRoot, process.env.PI_MEME_DATA_ROOT)
    if ((await realpath(options.staticDirectory)) !== snapshot.staticDirectory)
      throw new Error('runtime-snapshot-invalid: 拥有者界面必须来自当前固定快照')
  } else if (process.env.NODE_ENV === 'development')
    throw new Error('runtime-snapshot-required: 开发拥有者界面不能直接服务可写源码或 HMR')
  const upstream = assertLocalHostUrl(options.upstreamUrl)
  const upstreamAddress = new URL(upstream)
  const sockets = new Set<Duplex>()
  let url = ''
  const allowed = (request: IncomingMessage) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) return false
    return request.headers.host === new URL(url).host && (!request.headers.origin || request.headers.origin === url)
  }
  const expectedCookie = sessionCookieName(options.hostId)
  const belongsToUpstream = (pair: string) => {
    const name = pair.slice(0, pair.indexOf('=')).trim()
    return name === expectedCookie || (name !== 'pi_meme_session' && !name.startsWith(hostSessionCookiePrefix))
  }
  const scopedCookie = (source?: string) => source?.split(';').filter(belongsToUpstream).join('; ')
  const forwardedHeaders = (source: Headers) => {
    const headers = new Headers(source)
    headers.set('host', upstreamAddress.host)
    if (headers.has('origin')) headers.set('origin', upstreamAddress.origin)
    const cookie = scopedCookie(headers.get('cookie') ?? undefined)
    if (cookie) headers.set('cookie', cookie)
    else headers.delete('cookie')
    return headers
  }
  const target = (requestPath: string) => {
    const source = new URL(requestPath, 'http://frontend')
    const destination = new URL(upstream)
    destination.pathname = source.pathname
    destination.search = source.search
    return destination
  }
  const app = new Hono<{ Bindings: HttpBindings }>()
  app.onError((cause) => Response.json({ error: cause.message }, { status: 503 }))
  app.use('*', async (c, next) => {
    await next()
    c.header(controlPlaneResponseHeader, controlPlaneResponseValue)
    if (c.req.path !== visualizationPreviewPath) {
      c.header('Content-Security-Policy', "frame-ancestors 'none'", { append: true })
      c.header('X-Frame-Options', 'DENY')
    }
  })
  app.use('*', async (c, next) => {
    if (!allowed(c.env.incoming)) return Response.json({ error: '请求来源无效' }, { status: 403 })
    return next()
  })
  app.all('/api/*', async (c) => {
    if (c.req.path === '/api/auth')
      await waitForLocalHost(upstream, { hostId: options.hostId, timeoutMs: options.readinessTimeoutMs })
    // 只转发调用者自己的 Cookie；代理不持有或注入上游 owner 凭据。
    const request = new Request(target(c.env.incoming.url ?? '/'), c.req.raw)
    const headers = forwardedHeaders(request.headers)
    request.headers.delete('cookie')
    for (const [name, value] of headers) request.headers.set(name, value)
    const response = await fetchLocal(request)
    const cookies = response.headers.getSetCookie().filter(belongsToUpstream)
    response.headers.delete('set-cookie')
    for (const cookie of cookies) response.headers.append('set-cookie', cookie)
    return response
  })
  app.notFound((c) => serveFrontend(c.env.incoming.url ?? '/', { staticDirectory: options.staticDirectory }))
  const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false })
  server.on('upgrade', (request: IncomingMessage, downstream: Duplex, head: Buffer) => {
    const reject = (status: number, reason: string) =>
      downstream.end(
        `HTTP/1.1 ${status} ${reason}\r\n${controlPlaneResponseHeader}: ${controlPlaneResponseValue}\r\nConnection: close\r\n\r\n`,
      )
    if (!allowed(request) || !new URL(request.url ?? '/', url).pathname.startsWith('/api/')) {
      reject(403, 'Forbidden')
      return
    }
    sockets.add(downstream)
    const address = target(request.url ?? '/')
    const send = address.protocol === 'https:' ? httpsRequest : httpRequest
    const headers = {
      ...request.headers,
      host: upstreamAddress.host,
      ...(request.headers.origin ? { origin: upstreamAddress.origin } : {}),
    }
    const cookie = scopedCookie(request.headers.cookie)
    if (cookie) headers.cookie = cookie
    else delete headers.cookie
    const pending = send(address, { method: request.method, headers, timeout: 10000 })
    downstream.on('error', () => pending.destroy())
    downstream.once('close', () => {
      sockets.delete(downstream)
      pending.destroy()
    })
    pending.once('upgrade', (response, connection, initial) => {
      pending.setTimeout(0)
      sockets.add(connection)
      connection.once('close', () => {
        sockets.delete(connection)
        downstream.destroy()
      })
      connection.on('error', () => downstream.destroy())
      const headers = response.rawHeaders
        .reduce<string[]>((lines, value, index, values) => {
          if (
            index % 2 === 0 &&
            value.toLowerCase() !== controlPlaneResponseHeader.toLowerCase() &&
            (value.toLowerCase() !== 'set-cookie' || belongsToUpstream(values[index + 1]))
          )
            lines.push(`${value}: ${values[index + 1]}`)
          return lines
        }, [])
        .concat(`${controlPlaneResponseHeader}: ${controlPlaneResponseValue}`)
        .join('\r\n')
      downstream.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`)
      if (initial.length) downstream.write(initial)
      if (head.length) connection.write(head)
      downstream.pipe(connection).pipe(downstream)
    })
    pending.once('response', (response) => {
      response.resume()
      reject(response.statusCode ?? 502, 'Host Rejected')
    })
    pending.once('timeout', () => pending.destroy())
    pending.once('error', () => reject(503, 'Service Unavailable'))
    pending.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Desktop 界面地址无效')
  url = `http://127.0.0.1:${address.port}`
  let disposing: Promise<void> | undefined
  return {
    url,
    dispose() {
      disposing ??= (async () => {
        for (const socket of sockets) socket.destroy()
        if ('closeAllConnections' in server) server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close((cause) => (cause ? reject(cause) : resolve())))
      })()
      return disposing
    },
  }
}
