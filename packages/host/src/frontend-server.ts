import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable, type Duplex } from 'node:stream'
import { createAdaptorServer, type HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import { proxy } from 'hono/proxy'
import { serveFrontend } from './frontend'
import { assertLocalHostUrl, waitForLocalHost } from './host-status'
import { createTransportAuth } from './transport-auth'

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
}) {
  const upstream = assertLocalHostUrl(options.upstreamUrl)
  const auth = createTransportAuth({
    hostId: options.hostId,
    hostname: '127.0.0.1',
    token: '',
    tls: false,
    localAutoLogin: true,
  })
  const sockets = new Set<Duplex>()
  let url = ''
  const allowed = (request: IncomingMessage) =>
    auth.allowedSource(request) && new URL(`http://${request.headers.host}`).port === new URL(url).port
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
    if (!allowed(c.env.incoming)) return Response.json({ error: '请求来源无效' }, { status: 403 })
    return next()
  })
  app.all('/api/*', async (c) => {
    if (c.req.path === '/api/auth')
      await waitForLocalHost(upstream, { hostId: options.hostId, timeoutMs: options.readinessTimeoutMs })
    return proxy(target(c.env.incoming.url ?? '/'), { raw: c.req.raw, redirect: 'manual', customFetch: fetchLocal })
  })
  app.notFound((c) => serveFrontend(c.env.incoming.url ?? '/', { staticDirectory: options.staticDirectory }))
  const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false })
  server.on('upgrade', (request: IncomingMessage, downstream: Duplex, head: Buffer) => {
    if (!allowed(request) || !new URL(request.url ?? '/', url).pathname.startsWith('/api/')) {
      downstream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    sockets.add(downstream)
    const address = target(request.url ?? '/')
    const send = address.protocol === 'https:' ? httpsRequest : httpRequest
    const pending = send(address, { method: request.method, headers: request.headers, timeout: 10000 })
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
          if (index % 2 === 0) lines.push(`${value}: ${values[index + 1]}`)
          return lines
        }, [])
        .join('\r\n')
      downstream.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`)
      if (initial.length) downstream.write(initial)
      if (head.length) connection.write(head)
      downstream.pipe(connection).pipe(downstream)
    })
    pending.once('response', (response) => {
      response.resume()
      downstream.end(`HTTP/1.1 ${response.statusCode ?? 502} Host Rejected\r\nConnection: close\r\n\r\n`)
    })
    pending.once('timeout', () => pending.destroy())
    pending.once('error', () => downstream.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'))
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
        auth.dispose()
      })()
      return disposing
    },
  }
}
