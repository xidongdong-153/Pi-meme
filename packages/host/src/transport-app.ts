import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { compress } from 'hono/compress'
import { upgradeWebSocket, type HttpBindings } from '@hono/node-server'
import { WebSocket } from 'ws'
import { maxImagePreviewBytes, type HostControlRequest, type EventSubscription } from '@pi-meme/contracts/app-host'
import { MAX_CHAT_ATTACHMENT_BYTES } from '@pi-meme/contracts/chat-attachments'
import { isHostRpcRequest, type HostRpcRequest } from '@pi-meme/contracts/host'
import type { SshConnectionInput } from '@pi-meme/contracts/ssh-connections'
import { discoverSshCandidates } from './ssh-config'
import { sshUnavailableReason } from './ssh-tunnels'
import type { LocalHostStatus } from '@pi-meme/contracts/host-runtime'
import type { createHost } from './service'
import type { RemoteServices } from './remote-services'
import type { createTransportAuth } from './transport-auth'
import type { ServerOptions } from './server'
import { frontendMime, serveFrontend } from './frontend'
import { ChatAttachmentTooLargeError } from './chat-attachments'
import { ImageUploadTooLargeError } from './image-uploads'
import { createLinkPreviewLoader } from './link-preview'
import { previewLinkedFile } from './workspace-files'
import { visualizationPreviewPath, visualizationPreviewResponse } from '@pi-meme/visualize/server/preview-page'

type TransportEnv = {
  Bindings: Pick<HttpBindings, 'incoming'> & Partial<Pick<HttpBindings, 'outgoing'>>
  Variables: { url: URL }
}
type TransportContext = Context<TransportEnv>
type TransportServices = {
  host: Awaited<ReturnType<typeof createHost>>
  remotes: RemoteServices
  auth: ReturnType<typeof createTransportAuth>
  options: Pick<ServerOptions, 'staticDirectory' | 'frontendUrl' | 'owner' | 'appUpdate'>
}

function reply(status: number, value: unknown, headers?: Record<string, string>) {
  const start = performance.now()
  const body = JSON.stringify(value)
  const timing = headers?.['Server-Timing']
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...headers,
      ...(timing ? { 'Server-Timing': `${timing}, serialize;dur=${(performance.now() - start).toFixed(1)}` } : {}),
    },
  })
}

async function jsonBody(request: Request, pluginUpload = false) {
  const chunks: Buffer[] = []
  let bytes = 0
  const reader = request.body?.getReader()
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > (pluginUpload ? 48 : 32) * 1024 * 1024) throw new Error('请求内容超过大小限制')
        chunks.push(Buffer.from(value))
      }
    }
  } finally {
    reader?.releaseLock()
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (
    bytes > 32 * 1024 * 1024 &&
    (!value ||
      typeof value !== 'object' ||
      !('method' in value) ||
      !['plugins:install-package', 'resources:import'].includes(String(value.method)))
  )
    throw new Error('普通请求内容超过 32 MiB')
  return value
}

function serviceRegistrationError(cause: unknown) {
  if (!(cause instanceof Error)) return '远程服务登记失败'
  const source = cause.cause
  const code =
    source && typeof source === 'object' && 'code' in source && typeof source.code === 'string'
      ? source.code
      : undefined
  if (code && /CERT|SELF_SIGNED|ISSUER|TLS/.test(code)) return `远程服务 HTTPS 证书校验失败：${code}`
  if (cause.message === 'fetch failed')
    return code ? `无法连接远程服务：${code}` : '无法连接远程服务，请检查网络和 HTTPS 地址'
  return cause.message.replace(/https?:\/\/\S+/g, '[服务地址]')
}

async function connectionAction(
  { method, args }: HostRpcRequest,
  remotes: RemoteServices,
  canManage: boolean,
  host: TransportServices['host'],
) {
  const [value, enabled] = args
  switch (method) {
    case 'host:ssh:capabilities': {
      const available = canManage && (await remotes.ssh.available())
      return {
        canManage,
        available,
        reason: !canManage ? '请在本机打开应用后管理 SSH 连接' : !available ? sshUnavailableReason() : undefined,
      }
    }
    case 'host:ssh:list':
      return remotes.ssh.list()
    case 'host:ssh:discover':
      return discoverSshCandidates()
    case 'host:ssh:save':
      return remotes.ssh.save(value as SshConnectionInput)
    case 'host:ssh:enabled': {
      if (typeof value !== 'string' || typeof enabled !== 'boolean') throw new Error('SSH 启停参数无效')
      return remotes.ssh.setEnabled(value, enabled)
    }
    case 'host:ssh:retry':
    case 'host:ssh:remove': {
      if (typeof value !== 'string') throw new Error('SSH 连接标识无效')
      return method === 'host:ssh:retry' ? remotes.ssh.retry(value) : remotes.ssh.remove(value)
    }
    case 'host:connections:list':
      return host.connections.list()
    case 'host:connections:remove': {
      if (typeof value !== 'string') throw new Error('服务地址无效')
      return remotes.removeSavedConnection(value)
    }
    case 'host:services:list':
      return remotes.list()
    case 'host:services:register': {
      const input = value as { url?: unknown; token?: unknown } | undefined
      if (typeof input?.url !== 'string' || (input.token !== undefined && typeof input.token !== 'string'))
        throw new Error('远程服务登记参数无效')
      return remotes.register(input.url, input.token).catch((cause: unknown) => {
        throw new Error(serviceRegistrationError(cause))
      })
    }
    case 'host:services:retry':
    case 'host:services:remove': {
      if (typeof value !== 'string') throw new Error('服务标识无效')
      return method === 'host:services:retry' ? remotes.retry(value) : remotes.remove(value)
    }
    default:
      throw new Error('连接管理接口不存在')
  }
}

function registerRpc(app: Hono<TransportEnv>, { host, remotes, auth }: TransportServices) {
  const loadLinkPreview = createLinkPreviewLoader()
  app.use('/api/rpc', compress())
  app.use('/api/control', compress())
  app.post('/api/images/upload', async (c) => {
    if (Number(c.req.header('Content-Length')) > maxImagePreviewBytes) throw new ImageUploadTooLargeError()
    const query = c.get('url').searchParams
    const result = await host.uploadImage(
      {
        clientId: query.get('clientId') ?? '',
        hostId: query.get('hostId') ?? '',
        name: query.get('name') ?? '',
        idempotencyKey: query.get('idempotencyKey') ?? '',
      },
      c.req.raw.body ? Readable.fromWeb(c.req.raw.body as import('node:stream/web').ReadableStream) : Readable.from([]),
      c.req.raw.signal,
    )
    return reply(200, { hostId: host.hostId, result })
  })
  app.post('/api/chat/attachments', async (c) => {
    if (Number(c.req.header('Content-Length')) > MAX_CHAT_ATTACHMENT_BYTES) throw new ChatAttachmentTooLargeError()
    const query = c.get('url').searchParams
    const result = await host.uploadAttachment(
      {
        clientId: query.get('clientId') ?? '',
        hostId: query.get('hostId') ?? '',
        sessionKey: query.get('sessionKey') ?? '',
        name: query.get('name') ?? '',
      },
      c.req.raw.body ? Readable.fromWeb(c.req.raw.body as import('node:stream/web').ReadableStream) : Readable.from([]),
      c.req.raw.signal,
    )
    return reply(200, { hostId: host.hostId, result })
  })
  app.post('/api/control', async (c) => {
    return reply(200, await host.control.dispatch((await jsonBody(c.req.raw)) as HostControlRequest))
  })
  app.post('/api/rpc', async (c) => {
    const value = await jsonBody(c.req.raw, true)
    if (!isHostRpcRequest(value)) throw new Error('请求参数无效')
    if (
      (['host:import-keychain', 'host:credential-import-status'].includes(value.method) ||
        value.method.startsWith('browser:')) &&
      !auth.localRequest(c.env.incoming)
    )
      return reply(403, { error: '旧凭据只能在本机服务导入' })
    if (value.hostId && value.hostId !== host.hostId) throw new Error('请求服务身份不匹配')
    if (value.method === 'host:running-session-count') {
      if (!auth.localRequest(c.env.incoming)) return reply(403, { error: '退出状态只允许在本机读取' })
      return reply(200, { requestId: value.requestId, hostId: host.hostId, result: host.control.runningSessionCount() })
    }
    if (value.method === 'chat:file-preview') {
      const ref = value.args[0] as { hostId: string; sessionId: string }
      const session = await host.control.apiFor(value.clientId).sessions.get(ref)
      return reply(200, {
        requestId: value.requestId,
        hostId: host.hostId,
        result: await previewLinkedFile(session.cwd, value.args[1] as string, host.root),
      })
    }
    if (value.method === 'chat:link-preview') {
      return reply(200, {
        requestId: value.requestId,
        hostId: host.hostId,
        result: await loadLinkPreview(value.args[0]),
      })
    }
    const ssh = value.method.startsWith('host:ssh:')
    const savedConnection = value.method === 'host:connections:list' || value.method === 'host:connections:remove'
    let transportAction: (() => Promise<unknown>) | undefined
    if (ssh || savedConnection || value.method.startsWith('host:services:')) {
      const canManage = auth.localRequest(c.env.incoming)
      if (!canManage && ssh && value.method !== 'host:ssh:capabilities')
        return reply(403, { error: '请在本机打开应用后管理 SSH 连接' })
      if (!canManage && savedConnection) return reply(403, { error: '本机连接记录只能在本机管理' })
      transportAction = () => connectionAction(value, remotes, canManage, host)
    }
    const start = performance.now()
    const result = await host.rpc(value, { signal: c.req.raw.signal, transportAction })
    return reply(200, result, { 'Server-Timing': `host;dur=${(performance.now() - start).toFixed(1)}` })
  })
  app.get('/api/snapshot', async (c) => {
    if (c.req.method !== 'GET') return c.notFound()
    const url = c.get('url')
    const result = await host.rpc({
      requestId: randomBytes(16).toString('hex'),
      clientId: url.searchParams.get('clientId') || 'legacy-snapshot',
      sessionId: url.searchParams.get('sessionId') ?? undefined,
      method: 'pi:snapshot',
      args: [],
    })
    return reply(
      result.error ? 400 : 200,
      result.error ? result : { ...(result.result as object), hostId: host.hostId },
    )
  })
}

function registerEvents(app: Hono<TransportEnv>, { host, remotes }: TransportServices) {
  const events = (c: TransportContext) => {
    if (c.env.outgoing) return c.notFound()
    const url = c.get('url')
    const clientId = url.searchParams.get('clientId')!
    let dispose: (() => void) | undefined
    let disposeChanges: (() => void) | undefined
    return upgradeWebSocket(c, {
      onOpen(_event, ws) {
        if (url.pathname === '/api/control/events') {
          try {
            const input: EventSubscription = JSON.parse(url.searchParams.get('subscription') ?? '{}')
            if (
              !input ||
              typeof input !== 'object' ||
              (input.after &&
                (typeof input.after.journalEpoch !== 'string' ||
                  !Number.isSafeInteger(input.after.seq) ||
                  input.after.seq < 0))
            )
              throw new Error('事件订阅参数无效')
            dispose = host.control.subscribe(input, (event) => {
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
            })
          } catch {
            ws.close(1008, '事件订阅参数无效')
          }
          return
        }
        const remote = url.pathname.match(/^\/api\/services\/([a-f0-9]{24})\/api\/(control\/)?events$/)
        if (remote) {
          if (!(ws.raw instanceof WebSocket)) {
            ws.close(1011, '远程服务连接类型无效')
            return
          }
          void remotes
            .events(
              remote[1],
              clientId,
              ws.raw,
              remote[2] ? (url.searchParams.get('subscription') ?? '{}') : undefined,
              url.searchParams.get('connectionId') ?? undefined,
            )
            .catch(() => ws.close(1011, '远程服务订阅失败'))
          return
        }
        disposeChanges = remotes.onChanged(() => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ hostId: host.hostId, type: 'services-changed' }))
        })
        void host
          .subscribe(
            clientId,
            (event) => {
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
            },
            url.searchParams.get('connectionId') ?? undefined,
          )
          .then((unsubscribe) => {
            if (ws.readyState === WebSocket.OPEN) dispose = unsubscribe
            else unsubscribe()
          })
          .catch(() => ws.close(1011, '服务订阅失败'))
      },
      onClose() {
        disposeChanges?.()
        dispose?.()
      },
    })
  }
  app.get('/api/events', events)
  app.get('/api/control/events', events)
  for (const route of ['/api/services/:id/api/events', '/api/services/:id/api/control/events']) {
    app.get(route, (c, next) => (c.env.outgoing ? next() : events(c)))
  }
}

function registerResources(app: Hono<TransportEnv>, { host, remotes }: TransportServices) {
  app.all('/api/services/:id/api/*', async (c, next) => {
    const remote = c.get('url').pathname.match(/^\/api\/services\/([a-f0-9]{24})(\/api\/.*)$/)
    if (!remote) return next()
    const binaryUpload =
      c.req.method === 'POST' && (remote[2] === '/api/chat/attachments' || remote[2] === '/api/images/upload')
    if (remote[2] === '/api/images/upload' && Number(c.req.header('Content-Length')) > maxImagePreviewBytes)
      throw new ImageUploadTooLargeError()
    const upstream = binaryUpload
      ? remote[2] === '/api/images/upload'
        ? await remotes.uploadImage(remote[1], c.get('url').searchParams, c.req.raw.body, c.req.raw.signal)
        : await remotes.uploadAttachment(remote[1], c.get('url').searchParams, c.req.raw.body, c.req.raw.signal)
      : await remotes.request(
          remote[1],
          remote[2],
          c.req.method,
          c.req.method === 'POST' ? JSON.stringify(await jsonBody(c.req.raw, true)) : undefined,
          c.req.raw.signal,
        )
    return new Response(new Uint8Array(upstream.data), {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  })
  app.get('/api/plugins/*', async (c) => {
    if (c.req.method !== 'GET') return c.notFound()
    const parts = c.get('url').pathname.slice('/api/plugins/'.length).split('/')
    if (parts.shift() !== host.instanceId) return reply(404, { error: '插件资源已过期，请刷新快照' })
    const id = decodeURIComponent(parts.shift() ?? '')
    const generation = Number(parts.shift())
    const relative = parts.map((part) => decodeURIComponent(part)).join('/')
    const descriptor = host.plugins.getGeneration(id, generation)
    if (
      !descriptor ||
      !relative ||
      relative.split('/').some((part) => !part || part === '..' || part === '.' || part.includes('\\'))
    )
      return reply(404, { error: '插件资源不存在' })
    const root = await realpath(descriptor.directory)
    const target = await realpath(path.join(root, relative))
    if (!target.startsWith(`${root}${path.sep}`)) return reply(403, { error: '插件资源路径无效' })
    return new Response(new Uint8Array(await readFile(target)), {
      headers: {
        'Content-Type': frontendMime[path.extname(target)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    })
  })
}

export function createTransportApp(services: TransportServices) {
  const { host, auth, options } = services
  const app = new Hono<TransportEnv>({ getPath: (request) => new URL(request.url).pathname })
  app.onError((cause) =>
    reply(cause instanceof ChatAttachmentTooLargeError || cause instanceof ImageUploadTooLargeError ? 413 : 400, {
      error: cause.message,
    }),
  )
  app.use('*', async (c, next) => {
    const request = c.env.incoming
    if (!auth.allowedSource(request)) return reply(403, { error: '请求来源无效' })
    const url = new URL(request.url ?? '/', 'http://host')
    c.set('url', url)
    const upgrade = !c.env.outgoing
    if (url.pathname === '/api/status' && c.req.method === 'GET' && !upgrade) {
      if (!auth.localRequest(request)) return reply(403, { error: '服务状态只允许本机来源读取' })
      const status: LocalHostStatus = {
        product: 'pi-meme',
        hostId: host.hostId,
        instanceId: host.instanceId,
        dataRoot: await realpath(host.root),
        owner: options.owner ?? 'server',
      }
      return reply(200, status)
    }
    if (
      (upgrade || url.pathname.startsWith('/api/')) &&
      !(url.pathname === '/api/auth' && c.req.method === 'POST' && !upgrade) &&
      !auth.authenticated(request)
    )
      return reply(401, { error: '需要登录服务' })
    if (upgrade) {
      if (
        url.pathname !== '/api/events' &&
        url.pathname !== '/api/control/events' &&
        !/^\/api\/services\/[a-f0-9]{24}\/api\/(?:control\/)?events$/.test(url.pathname)
      )
        return reply(404, { error: '服务接口不存在' })
      const clientId = url.searchParams.get('clientId')
      if (!clientId || clientId.length > 128) return reply(400, { error: '客户端标识无效' })
    }
    return next()
  })
  app.post('/api/auth', async (c) => {
    const result = auth.login(c.env.incoming, (await jsonBody(c.req.raw)) as { token?: unknown })
    return reply(
      result.status,
      result.error
        ? { error: result.error }
        : {
            hostId: host.hostId,
            authMode: auth.authMode,
            capabilities: { sshTunnelAuth: true },
          },
      result.cookie ? { 'Set-Cookie': result.cookie } : undefined,
    )
  })
  // 固定沙箱壳公开提供，不含会话、凭据或草图数据。内容仅由父页面通过端口传入。
  app.get(visualizationPreviewPath, () => visualizationPreviewResponse())
  app.get('/api/update', () => {
    if (!options.appUpdate) return reply(404, { error: '当前服务未提供版本信息' })
    return reply(200, { hostId: host.hostId, result: options.appUpdate.getInfo() })
  })
  app.post('/api/update/check', async (c) => {
    if (!options.appUpdate) return reply(404, { error: '当前服务未提供更新检查' })
    const input = await jsonBody(c.req.raw)
    if (!input || typeof input !== 'object' || !('force' in input) || typeof input.force !== 'boolean')
      return reply(400, { error: '检查更新参数无效' })
    return reply(200, { hostId: host.hostId, result: await options.appUpdate.check(input.force) })
  })
  registerEvents(app, services)
  registerResources(app, services)
  registerRpc(app, services)
  app.notFound((c) =>
    c.get('url').pathname.startsWith('/api/') || !c.env.outgoing
      ? reply(404, { error: '服务接口不存在' })
      : serveFrontend(c.env.incoming.url ?? '/', options),
  )
  return app
}
