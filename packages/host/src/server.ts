import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFile, stat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { WebSocketServer } from 'ws'
import type { HostRpcRequest } from '@pi-meme/contracts/host'
import { createHost, type HostOptions } from './service'
import { RemoteServices } from './remote-services'

export type ServerOptions = HostOptions & {
  hostname?: string
  port?: number
  token?: string
  localAutoLogin?: boolean
  staticDirectory?: string
  frontendUrl?: string
  tls?: { key: string | Buffer; cert: string | Buffer }
}
function equal(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}
async function jsonBody(request: IncomingMessage, pluginUpload = false) {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const value of request) {
    const chunk = Buffer.from(value as Uint8Array)
    bytes += chunk.length
    if (bytes > (pluginUpload ? 48 : 32) * 1024 * 1024) throw new Error('请求内容超过大小限制')
    chunks.push(chunk)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (
    bytes > 32 * 1024 * 1024 &&
    (!value || typeof value !== 'object' || !('method' in value) || value.method !== 'plugins:install-package')
  )
    throw new Error('普通请求内容超过 32 MiB')
  return value
}
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

export async function startHostServer(options: ServerOptions = {}) {
  const hostname = options.hostname ?? '127.0.0.1'
  const local = ['127.0.0.1', 'localhost', '::1'].includes(hostname)
  if (!local && !options.tls) throw new Error('远程 Host 必须配置 HTTPS 证书和私钥')
  const host = await createHost(options)
  const remotes = new RemoteServices(host.connections, host.root)
  try {
    await remotes.initialize()
  } catch (cause) {
    await host.dispose()
    throw cause
  }
  const token = options.token ?? host.credentials.get('host:token') ?? randomBytes(32).toString('base64url')
  if (host.credentials.get('host:token') !== token) {
    try {
      host.credentials.set('host:token', token)
      await host.flushCredentials()
    } catch (cause) {
      await host.dispose()
      throw cause
    }
  }
  const localAutoLogin = Boolean(options.localAutoLogin && local)
  const localRequest = (request: IncomingMessage) => {
    if (!local || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) return false
    try {
      const authority = new URL(`${options.tls ? 'https' : 'http'}://${request.headers.host}`)
      return (
        ['localhost', '127.0.0.1', '[::1]'].includes(authority.hostname) &&
        !authority.username &&
        !authority.password &&
        authority.origin === `${options.tls ? 'https' : 'http'}://${request.headers.host}`
      )
    } catch {
      return false
    }
  }
  const tickets = new Map<string, number>()
  const sessions = new Map<string, number>()
  const authenticated = (request: IncomingMessage) => {
    const cookie = request.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith('pi_meme_session='))
      ?.slice('pi_meme_session='.length)
    const expires = cookie ? sessions.get(cookie) : undefined
    return Boolean(expires && expires > Date.now())
  }
  const allowedOrigin = (request: IncomingMessage) => {
    if (!request.headers.origin) return true
    return request.headers.origin === `${options.tls ? 'https' : 'http'}://${request.headers.host}`
  }
  const reply = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(value))
  }
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (!allowedOrigin(request) || (localAutoLogin && !localRequest(request)))
        return reply(response, 403, { error: '请求来源无效' })
      const url = new URL(request.url ?? '/', 'http://host')
      if (url.pathname === '/api/auth' && request.method === 'POST') {
        const value = (await jsonBody(request)) as { token?: unknown }
        if (value?.token !== undefined && typeof value.token !== 'string')
          return reply(response, 401, { error: '访问令牌无效' })
        if (value.token) {
          const expires = tickets.get(value.token)
          const ticket = expires !== undefined && expires > Date.now()
          if (!ticket && !equal(value.token, token)) return reply(response, 401, { error: '访问令牌无效' })
          tickets.delete(value.token)
        } else {
          if (authenticated(request)) return reply(response, 200, { hostId: host.hostId })
          if (!localAutoLogin || !localRequest(request) || !request.headers.origin || request.headers.origin === 'null')
            return reply(response, 401, { error: '需要登录 Host' })
        }
        const session = randomBytes(32).toString('base64url')
        sessions.set(session, Date.now() + 24 * 60 * 60 * 1000)
        response.setHeader(
          'Set-Cookie',
          `pi_meme_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${options.tls ? '; Secure' : ''}`,
        )
        return reply(response, 200, { hostId: host.hostId })
      }
      if (url.pathname.startsWith('/api/')) {
        if (!authenticated(request)) return reply(response, 401, { error: '需要登录 Host' })
        const remote = url.pathname.match(/^\/api\/services\/([a-f0-9]{24})(\/api\/.*)$/)
        if (remote) {
          const body = request.method === 'POST' ? JSON.stringify(await jsonBody(request, true)) : undefined
          const upstream = await remotes.request(remote[1], remote[2], request.method ?? 'GET', body)
          response.writeHead(upstream.status, {
            'Content-Type': upstream.contentType,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          })
          response.end(upstream.data)
          return
        }
        if (url.pathname.startsWith('/api/plugins/') && request.method === 'GET') {
          const parts = url.pathname.slice('/api/plugins/'.length).split('/')
          if (parts.shift() !== host.instanceId) return reply(response, 404, { error: '插件资源已过期，请刷新快照' })
          const id = decodeURIComponent(parts.shift() ?? '')
          const generation = Number(parts.shift())
          const relative = parts.map((part) => decodeURIComponent(part)).join('/')
          const descriptor = host.plugins.getGeneration(id, generation)
          if (
            !descriptor ||
            !relative ||
            relative.split('/').some((part) => !part || part === '..' || part === '.' || part.includes('\\'))
          )
            return reply(response, 404, { error: '插件资源不存在' })
          const root = await realpath(descriptor.directory)
          const target = await realpath(path.join(root, relative))
          if (!target.startsWith(`${root}${path.sep}`)) return reply(response, 403, { error: '插件资源路径无效' })
          const data = await readFile(target)
          response.writeHead(200, {
            'Content-Type': mime[path.extname(target)] ?? 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=31536000, immutable',
          })
          response.end(data)
          return
        }
        if (url.pathname === '/api/rpc' && request.method === 'POST') {
          const value = (await jsonBody(request, true)) as HostRpcRequest
          if (
            ['host:import-keychain', 'host:credential-import-status'].includes(value.method) &&
            !localRequest(request)
          )
            return reply(response, 403, { error: '旧凭据只能在本机 Host 导入' })
          if (
            !value ||
            typeof value.method !== 'string' ||
            typeof value.clientId !== 'string' ||
            !value.clientId ||
            value.clientId.length > 128 ||
            typeof value.requestId !== 'string' ||
            !value.requestId ||
            value.requestId.length > 128 ||
            !Array.isArray(value.args)
          )
            throw new Error('请求参数无效')
          if (value.hostId && value.hostId !== host.hostId) throw new Error('请求 Host 身份不匹配')
          if (value.method.startsWith('host:services:')) {
            let result: unknown
            switch (value.method) {
              case 'host:services:list':
                result = remotes.list()
                break
              case 'host:services:register': {
                const input = value.args[0] as { url?: unknown; token?: unknown }
                if (typeof input?.url !== 'string' || (input.token !== undefined && typeof input.token !== 'string'))
                  throw new Error('远程服务登记参数无效')
                result = await remotes.register(input.url, input.token)
                break
              }
              case 'host:services:retry':
              case 'host:services:remove':
                if (typeof value.args[0] !== 'string') throw new Error('服务标识无效')
                result = value.method.endsWith(':retry')
                  ? await remotes.retry(value.args[0])
                  : await remotes.remove(value.args[0])
                break
              default:
                throw new Error('服务管理接口不存在')
            }
            return reply(response, 200, { requestId: value.requestId, hostId: host.hostId, result })
          }
          return reply(response, 200, await host.rpc(value))
        }
        if (url.pathname === '/api/snapshot' && request.method === 'GET') {
          const result = await host.rpc({
            requestId: randomBytes(16).toString('hex'),
            clientId: url.searchParams.get('clientId') ?? '',
            sessionId: url.searchParams.get('sessionId') ?? undefined,
            method: 'pi:snapshot',
            args: [],
          })
          return reply(
            response,
            result.error ? 400 : 200,
            result.error ? result : { ...(result.result as object), hostId: host.hostId },
          )
        }
        return reply(response, 404, { error: 'Host 接口不存在' })
      }
      if (options.frontendUrl) {
        const upstream = await fetch(new URL(request.url ?? '/', options.frontendUrl))
        response.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        })
        response.end(Buffer.from(await upstream.arrayBuffer()))
        return
      }
      if (!options.staticDirectory) return reply(response, 404, { error: '没有配置 Web 静态目录' })
      const root = path.resolve(options.staticDirectory)
      let target = path.resolve(root, `.${decodeURIComponent(url.pathname)}`)
      if (target !== root && !target.startsWith(`${root}${path.sep}`))
        return reply(response, 403, { error: '文件路径无效' })
      if (!(await stat(target).catch(() => undefined))?.isFile()) target = path.join(root, 'index.html')
      const data = await readFile(target)
      const hashes =
        path.extname(target) === '.html'
          ? [...data.toString('utf8').matchAll(/<script\s[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/g)]
              .map((match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`)
              .join(' ')
          : ''
      response.writeHead(200, {
        'Content-Type': mime[path.extname(target)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `default-src 'self'; script-src 'self' ${hashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'`,
      })
      response.end(data)
    } catch (cause) {
      reply(response, 400, { error: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  const server = options.tls
    ? createHttpsServer(options.tls, (request, response) => {
        void handler(request, response)
      })
    : createHttpServer((request, response) => {
        void handler(request, response)
      })
  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://host')
    if (
      !authenticated(request) ||
      !allowedOrigin(request) ||
      (localAutoLogin && !localRequest(request)) ||
      (url.pathname !== '/api/events' && !/^\/api\/services\/[a-f0-9]{24}\/api\/events$/.test(url.pathname))
    ) {
      socket.destroy()
      return
    }
    const clientId = url.searchParams.get('clientId')
    if (!clientId || clientId.length > 128) {
      socket.destroy()
      return
    }
    sockets.handleUpgrade(request, socket, head, (connection) => {
      const remote = url.pathname.match(/^\/api\/services\/([a-f0-9]{24})\/api\/events$/)
      if (remote) {
        void remotes.events(remote[1], clientId, connection).catch(() => connection.close(1011, '远程服务订阅失败'))
        return
      }
      let dispose: (() => void) | undefined
      connection.on('close', () => dispose?.())
      void host
        .subscribe(clientId, (event) => {
          if (connection.readyState === 1) connection.send(JSON.stringify(event))
        })
        .then((unsubscribe) => {
          if (connection.readyState === 1) dispose = unsubscribe
          else unsubscribe()
        })
        .catch(() => connection.close(1011, 'Host 订阅失败'))
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 0, hostname, resolve)
    })
  } catch (cause) {
    await host.dispose()
    throw cause
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Host 地址无效')
  const url = `${options.tls ? 'https' : 'http'}://${hostname.includes(':') ? `[${hostname}]` : hostname}:${address.port}`
  let disposing: Promise<void> | undefined
  return {
    host,
    remotes,
    url,
    createBootstrapTicket() {
      const value = randomBytes(32).toString('base64url')
      tickets.set(value, Date.now() + 60000)
      return value
    },
    token,
    dispose() {
      disposing ??= (async () => {
        remotes.dispose()
        for (const connection of sockets.clients) connection.terminate()
        sockets.close()
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close((cause) => (cause ? reject(cause) : resolve())))
        sessions.clear()
        tickets.clear()
        await host.dispose()
      })()
      return disposing
    },
  }
}
