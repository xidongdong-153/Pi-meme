import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Socket } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpConfiguration } from './config'
import type { HostRegistry } from './hosts'
import { createMcpServer } from './tools'

function json(response: ServerResponse, status: number, message: string) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.shouldKeepAlive = false
  response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }))
}

export async function startHttpServer(configuration: McpConfiguration, registry: HostRegistry) {
  if (!configuration.token) throw new Error('HTTP MCP 需要独立访问令牌')
  const digest = (value: string) => createHash('sha256').update(value).digest()
  const expectedToken = digest(configuration.token)
  const sockets = new Set<Socket>()
  const active = new Set<McpServer>()
  let port = configuration.port
  let stopping = false
  const scheme = configuration.tls ? 'https' : 'http'
  const hostname = configuration.hostname.replace(/^\[|\]$/g, '')
  const publicUrl = configuration.publicUrl ? new URL(configuration.publicUrl) : undefined
  const hosts = () => {
    const names = new Set([`${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`.toLowerCase()])
    if (['localhost', '127.0.0.1', '::1'].includes(hostname)) {
      for (const host of ['localhost', '127.0.0.1', '[::1]']) names.add(`${host}:${port}`)
    }
    if (publicUrl) names.add(publicUrl.host.toLowerCase())
    return names
  }
  const origins = () =>
    new Set([
      ...configuration.allowedOrigins,
      ...[...hosts()].filter((host) => host !== publicUrl?.host.toLowerCase()).map((host) => `${scheme}://${host}`),
    ])

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    if (stopping) return json(response, 503, 'MCP 正在关闭')
    const host = request.headers.host
    if (!host || request.headersDistinct.host?.length !== 1 || !hosts().has(host.toLowerCase())) {
      return json(response, 403, 'Host 请求头未获允许')
    }
    const origin = request.headers.origin
    if (origin !== undefined) {
      if (request.headersDistinct.origin?.length !== 1 || !origins().has(origin))
        return json(response, 403, '请求来源未获允许')
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Vary', 'Origin')
      response.setHeader('Access-Control-Expose-Headers', 'MCP-Protocol-Version, WWW-Authenticate')
    }
    const url = new URL(request.url ?? '/', 'http://mcp.invalid')
    if (url.search || url.hash || !request.url?.startsWith('/'))
      return json(response, 400, 'MCP 地址不接受查询参数或片段')
    if (url.pathname === '/health' && request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ status: 'ok', service: 'pi-meme-mcp' }))
      return
    }
    if (url.pathname !== '/mcp') return json(response, 404, '接口不存在')
    if (request.method === 'OPTIONS') {
      if (!origin) return json(response, 403, '预检需要已授权 Origin')
      response.statusCode = 204
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Protocol-Version')
      response.end()
      return
    }
    const authorization = request.headers.authorization
    const token = authorization && authorization.length <= 520 && /^Bearer (\S+)$/i.exec(authorization)?.[1]
    if (
      request.headersDistinct.authorization?.length !== 1 ||
      !token ||
      !timingSafeEqual(digest(token), expectedToken)
    ) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="pi-meme-mcp"')
      return json(response, 401, '需要有效的 MCP Bearer 令牌')
    }
    if (request.headers['mcp-session-id'] !== undefined)
      return json(response, 400, '此服务使用无状态 HTTP，不接受 Mcp-Session-Id')
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST, OPTIONS')
      return json(response, 405, '此服务使用无状态 Streamable HTTP；只支持 POST，不提供独立 SSE 通道')
    }
    if (active.size >= 64) return json(response, 503, 'MCP 并发请求过多，请稍后重试；写操作保留原幂等键')
    const server = createMcpServer(registry)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 2 * 1024 * 1024,
    })
    active.add(server)
    const close = () => {
      if (!active.delete(server)) return
      void server.close().catch(() => console.error('MCP 请求连接清理失败'))
    }
    response.once('finish', close)
    response.once('close', close)
    try {
      await server.connect(transport)
      await transport.handleRequest(request, response)
    } catch {
      close()
      if (!response.headersSent) json(response, 500, 'MCP 请求处理失败')
      else response.end()
    }
  }

  const listener = (request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) json(response, 400, '无效的 HTTP 请求')
      else response.end()
    })
  }
  const http = configuration.tls ? createHttpsServer(configuration.tls, listener) : createServer(listener)
  http.requestTimeout = 30000
  http.headersTimeout = 10000
  http.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(configuration.port, hostname, () => {
      http.removeListener('error', reject)
      resolve()
    })
  })
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('无法取得 MCP 监听地址')
  port = address.port
  const url = `${scheme}://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}/mcp`
  http.on('error', () => console.error('MCP HTTP 服务发生错误'))
  return {
    url,
    async dispose() {
      stopping = true
      await Promise.allSettled([...active].map((server) => server.close()))
      active.clear()
      const closed = new Promise<void>((resolve) => http.close(() => resolve()))
      for (const socket of sockets) socket.destroy()
      await closed
    },
  }
}
