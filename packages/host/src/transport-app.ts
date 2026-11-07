import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createHash, randomBytes } from 'node:crypto'
import {
  controlPlaneResponseHeader,
  controlPlaneResponseValue,
  type TransportIdentity,
} from '@pi-meme/contracts/transport-identity'
import { Hono, type Context } from 'hono'
import { compress } from 'hono/compress'
import { upgradeWebSocket, type HttpBindings } from '@hono/node-server'
import { WebSocket } from 'ws'
import type { HostControlRequest, EventSubscription } from '@pi-meme/contracts/app-host'
import { MAX_CHAT_ATTACHMENT_BYTES } from '@pi-meme/contracts/chat-attachments'
import type { HostRpcRequest } from '@pi-meme/contracts/host'
import type { SshConnectionInput } from '@pi-meme/contracts/ssh-connections'
import { discoverSshCandidates } from './ssh-config'
import { sshUnavailableReason } from './ssh-tunnels'
import { hostRuntimeProtocolVersion, type LocalHostStatus } from '@pi-meme/contracts/host-runtime'
import type { createHost } from './service'
import type { RemoteServices } from './remote-services'
import type { createTransportAuth } from './transport-auth'
import type { ServerOptions } from './server'
import { frontendMime, serveFrontend } from './frontend'
import { ChatAttachmentTooLargeError } from './chat-attachments'
import { createLinkPreviewLoader } from './link-preview'
import { visualizationPreviewPath, visualizationPreviewResponse } from '@pi-meme/visualize/server/preview-page'

type TransportEnv = {
  Bindings: Pick<HttpBindings, 'incoming'> & Partial<Pick<HttpBindings, 'outgoing'>>
  Variables: { url: URL; identity: TransportIdentity }
}
type TransportContext = Context<TransportEnv>
type TransportServices = {
  host: Awaited<ReturnType<typeof createHost>>
  remotes: RemoteServices
  auth: ReturnType<typeof createTransportAuth>
  options: Pick<ServerOptions, 'staticDirectory' | 'frontendUrl' | 'owner'>
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

function authenticatedClientId(c: TransportContext, value: unknown, host: TransportServices['host']) {
  if (typeof value !== 'string' || !value || value.length > 128) throw new Error('客户端标识无效')
  const identity = c.get('identity')
  if (!identity) throw new Error('需要登录服务')
  const clientId = `client:${createHash('sha256')
    .update(JSON.stringify([identity.principalId, identity.installationId, value]))
    .digest('hex')}`
  host.registerAuthenticatedClient(clientId, identity)
  return clientId
}

function registerRpc(app: Hono<TransportEnv>, { host, remotes, auth }: TransportServices) {
  const loadLinkPreview = createLinkPreviewLoader()
  app.use('/api/rpc', compress())
  app.use('/api/control', compress())
  app.post('/api/chat/attachments', async (c) => {
    if (Number(c.req.header('Content-Length')) > MAX_CHAT_ATTACHMENT_BYTES) throw new ChatAttachmentTooLargeError()
    const query = c.get('url').searchParams
    const metadata = {
      clientId: authenticatedClientId(c, query.get('clientId'), host),
      hostId: query.get('hostId') ?? '',
      sessionKey: query.get('sessionKey') ?? '',
      name: query.get('name') ?? '',
    }
    const result = await host.authorizeTransport(
      {
        requestId: randomBytes(16).toString('hex'),
        clientId: metadata.clientId,
        kind: 'attachment',
        method: 'upload',
        args: [metadata],
      },
      c.req.raw.signal,
      (signal) =>
        host.uploadAttachment(
          metadata,
          c.req.raw.body
            ? Readable.fromWeb(c.req.raw.body as import('node:stream/web').ReadableStream)
            : Readable.from([]),
          signal,
        ),
    )
    return reply(200, { hostId: host.hostId, result })
  })
  app.post('/api/control', async (c) => {
    const request = (await jsonBody(c.req.raw)) as HostControlRequest
    request.clientId = authenticatedClientId(c, request?.clientId, host)
    return reply(200, await host.withIdentity(c.get('identity'), () => host.control.dispatch(request)))
  })
  app.post('/api/rpc', async (c) => {
    const value = (await jsonBody(c.req.raw, true)) as HostRpcRequest
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
    if (value.hostId && value.hostId !== host.hostId) throw new Error('请求服务身份不匹配')
    if (
      (['host:import-keychain', 'host:credential-import-status'].includes(value.method) ||
        value.method.startsWith('browser:')) &&
      !auth.localRequest(c.env.incoming)
    )
      return reply(403, { error: '旧凭据与浏览器操作只能在本机服务管理' })
    value.clientId = authenticatedClientId(c, value.clientId, host)
    if (value.method === 'host:control-origins') {
      const identity = c.get('identity')
      if (!identity || identity.role !== 'owner' || identity.hostId !== host.hostId || value.args.length)
        return reply(403, { error: '控制服务登记只允许已认证的 Owner 读取' })
      // Security metadata remains readable during revoke so the client cannot mistake a control page for business UI.
      c.req.raw.signal.throwIfAborted()
      return reply(200, {
        requestId: value.requestId,
        hostId: host.hostId,
        result: { origins: remotes.controlOrigins() },
      })
    }
    const special =
      ['chat:file-preview', 'chat:link-preview'].includes(value.method) ||
      /^(?:host:ssh:|host:connections:|host:services:)/.test(value.method)
    const perform = async (signal: AbortSignal) => {
      signal.throwIfAborted()
      if (value.method === 'chat:file-preview') {
        const ref = value.args[0] as { hostId: string; sessionId: string }
        return reply(200, {
          requestId: value.requestId,
          hostId: host.hostId,
          result: await host.readLinkedPreview(value.clientId, ref, value.args[1] as string, signal),
        })
      }
      if (value.method === 'chat:link-preview') {
        return reply(200, {
          requestId: value.requestId,
          hostId: host.hostId,
          result: await loadLinkPreview(value.args[0], signal),
        })
      }
      if (value.method.startsWith('host:ssh:')) {
        const canManage = auth.localRequest(c.env.incoming)
        let result: unknown
        if (value.method === 'host:ssh:capabilities') {
          const available = canManage && (await remotes.ssh.available())
          result = {
            canManage,
            available,
            reason: !canManage ? '请在本机打开应用后管理 SSH 连接' : !available ? sshUnavailableReason() : undefined,
          }
        } else {
          if (!canManage) return reply(403, { error: '请在本机打开应用后管理 SSH 连接' })
          switch (value.method) {
            case 'host:ssh:list':
              result = remotes.ssh.list()
              break
            case 'host:ssh:discover':
              result = await discoverSshCandidates()
              break
            case 'host:ssh:save':
              result = await remotes.ssh.save(value.args[0] as SshConnectionInput)
              break
            case 'host:ssh:enabled':
              if (typeof value.args[0] !== 'string' || typeof value.args[1] !== 'boolean')
                throw new Error('SSH 启停参数无效')
              result = await remotes.ssh.setEnabled(value.args[0], value.args[1])
              break
            case 'host:ssh:retry':
            case 'host:ssh:remove':
              if (typeof value.args[0] !== 'string') throw new Error('SSH 连接标识无效')
              result = value.method.endsWith(':retry')
                ? await remotes.ssh.retry(value.args[0])
                : await remotes.ssh.remove(value.args[0])
              break
            default:
              throw new Error('SSH 管理接口不存在')
          }
        }
        return reply(200, { requestId: value.requestId, hostId: host.hostId, result })
      }
      if (value.method === 'host:connections:list' || value.method === 'host:connections:remove') {
        if (!auth.localRequest(c.env.incoming)) return reply(403, { error: '本机连接记录只能在本机管理' })
        let result: unknown
        if (value.method === 'host:connections:list') result = host.connections.list()
        else {
          const url = value.args[0]
          if (typeof url !== 'string') throw new Error('服务地址无效')
          await remotes.removeSavedConnection(url)
        }
        return reply(200, { requestId: value.requestId, hostId: host.hostId, result })
      }
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
            result = await remotes.register(input.url, input.token, signal).catch((cause: unknown) => {
              throw new Error(serviceRegistrationError(cause))
            })
            break
          }
          case 'host:services:retry':
          case 'host:services:remove':
            if (typeof value.args[0] !== 'string') throw new Error('服务标识无效')
            result = value.method.endsWith(':retry')
              ? await remotes.retry(value.args[0], signal)
              : await remotes.remove(value.args[0])
            break
          default:
            throw new Error('服务管理接口不存在')
        }
        return reply(200, { requestId: value.requestId, hostId: host.hostId, result })
      }
      const start = performance.now()
      const result = await host.withIdentity(c.get('identity'), () => host.rpc(value))
      return reply(200, result, { 'Server-Timing': `host;dur=${(performance.now() - start).toFixed(1)}` })
    }
    if (special) {
      const session =
        value.method === 'chat:file-preview' ? (value.args[0] as { hostId: string; sessionId: string }) : undefined
      if (
        value.method === 'chat:file-preview' &&
        (!session ||
          typeof session.hostId !== 'string' ||
          typeof session.sessionId !== 'string' ||
          !session.sessionId ||
          session.hostId !== host.hostId ||
          typeof value.args[1] !== 'string')
      )
        throw new Error('文件预览会话身份无效')
      return host.withIdentity(c.get('identity'), () =>
        host.authorizeTransport(
          {
            requestId: value.requestId,
            clientId: value.clientId,
            kind: 'rpc',
            method: value.method,
            args: value.args,
            session,
          },
          c.req.raw.signal,
          perform,
        ),
      )
    }
    // The fixed Owner authorization controls remain reachable to recover from a Host-wide revoke.
    if (
      value.method.startsWith('authorization:') &&
      !['authorization:snapshot', 'authorization:respond', 'authorization:revoke', 'authorization:resume'].includes(
        value.method,
      )
    )
      throw new Error('授权管理接口不存在')
    return perform(c.req.raw.signal)
  })
  app.get('/api/snapshot', async (c) => {
    if (c.req.method !== 'GET') return c.notFound()
    const url = c.get('url')
    const result = await host.rpc({
      requestId: randomBytes(16).toString('hex'),
      clientId: authenticatedClientId(c, url.searchParams.get('clientId'), host),
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

function registerEvents(app: Hono<TransportEnv>, { host, remotes, auth }: TransportServices) {
  const events = (c: TransportContext) => {
    if (c.env.outgoing) return c.notFound()
    const url = c.get('url')
    const clientId = authenticatedClientId(c, url.searchParams.get('clientId'), host)
    // This is the actual cookie identity captured at handshake, never later ALS or client metadata.
    const identity = Object.freeze({ ...c.get('identity') })
    const valid = () =>
      auth.identity(c.env.incoming)?.connectionEpoch === identity.connectionEpoch &&
      host.isAuthenticatedClient(clientId, identity)
    const controller = new AbortController()
    let finish!: () => void
    const closed = new Promise<void>((resolve) => {
      finish = resolve
    })
    let dispose: (() => void) | undefined
    let disposeChanges: (() => void) | undefined
    const cleanup = () => {
      disposeChanges?.()
      disposeChanges = undefined
      dispose?.()
      dispose = undefined
      host.disconnectSystemClient(clientId, identity)
    }
    return upgradeWebSocket(c, {
      onOpen(_event, ws) {
        const remote = url.pathname.match(/^\/api\/services\/([a-f0-9]{24})\/api\/(control\/)?events$/)
        const method = remote ? 'remote-events' : url.pathname === '/api/control/events' ? 'control-events' : 'events'
        void host
          .withIdentity(identity, () =>
            host.authorizeTransport(
              {
                requestId: randomBytes(16).toString('hex'),
                clientId,
                kind: 'subscription',
                method,
                args: [url.pathname, url.searchParams.get('subscription')],
              },
              controller.signal,
              async (signal) => {
                const abort = () => ws.close(1008, '事件订阅授权已失效')
                const send = (event: unknown) => {
                  if (signal.aborted || !valid()) {
                    abort()
                    return
                  }
                  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
                }
                signal.addEventListener('abort', abort, { once: true })
                const timer = setInterval(() => {
                  if (!valid()) abort()
                }, 2500)
                timer.unref()
                try {
                  signal.throwIfAborted()
                  if (!valid() || ws.readyState !== WebSocket.OPEN) throw new Error('事件认证已失效')
                  if (method === 'control-events') {
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
                    dispose = host.control.subscribe(input, send)
                  } else if (remote) {
                    if (!(ws.raw instanceof WebSocket)) throw new Error('远程服务连接类型无效')
                    await remotes.events(
                      remote[1],
                      clientId,
                      ws.raw,
                      remote[2] ? (url.searchParams.get('subscription') ?? '{}') : undefined,
                      signal,
                    )
                  } else {
                    disposeChanges = remotes.onChanged(() => send({ hostId: host.hostId, type: 'services-changed' }))
                    const unsubscribe = await host.subscribe(clientId, send, identity)
                    if (ws.readyState === WebSocket.OPEN && !signal.aborted) dispose = unsubscribe
                    else unsubscribe()
                  }
                  await closed
                } finally {
                  clearInterval(timer)
                  signal.removeEventListener('abort', abort)
                  cleanup()
                }
              },
            ),
          )
          .catch(() => {
            ws.close(1008, '事件订阅未获授权或已失效')
            cleanup()
          })
      },
      onClose() {
        controller.abort()
        finish()
        cleanup()
      },
      onError() {
        controller.abort()
        finish()
        cleanup()
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
    const attachment = remote[2] === '/api/chat/attachments' && c.req.method === 'POST'
    const query = new URLSearchParams(c.get('url').searchParams)
    let clientId: string | undefined
    let body: unknown
    if (attachment) {
      clientId = authenticatedClientId(c, query.get('clientId'), host)
      query.set('clientId', clientId)
    } else if (c.req.method === 'POST') {
      body = await jsonBody(c.req.raw, true)
      if (remote[2] === '/api/rpc' || remote[2] === '/api/control') {
        if (!body || typeof body !== 'object' || !('clientId' in body)) throw new Error('远程客户端请求无效')
        clientId = authenticatedClientId(c, body.clientId, host)
        body = { ...body, clientId }
      }
    }
    const upstream = await host.authorizeTransport(
      {
        requestId: randomBytes(16).toString('hex'),
        clientId,
        kind: 'proxy',
        method: c.req.method,
        args: [remote[1], remote[2], body ?? null],
      },
      c.req.raw.signal,
      async (signal) => {
        signal.throwIfAborted()
        return attachment
          ? remotes.uploadAttachment(remote[1], query, c.req.raw.body, signal)
          : remotes.request(
              remote[1],
              remote[2],
              c.req.method,
              body === undefined ? undefined : JSON.stringify(body),
              signal,
            )
      },
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
    return host.authorizeTransport(
      {
        requestId: randomBytes(16).toString('hex'),
        kind: 'resource',
        method: 'plugin-resource',
        args: [c.get('url').pathname],
      },
      c.req.raw.signal,
      async (signal) => {
        signal.throwIfAborted()
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
        signal.throwIfAborted()
        return new Response(new Uint8Array(await readFile(target, { signal })), {
          headers: {
            'Content-Type': frontendMime[path.extname(target)] ?? 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy':
              "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            'Cache-Control': 'private, max-age=31536000, immutable',
          },
        })
      },
    )
  })
}

export function createTransportApp(services: TransportServices) {
  const { host, auth, options } = services
  const app = new Hono<TransportEnv>({ getPath: (request) => new URL(request.url).pathname })
  app.onError((cause) => reply(cause instanceof ChatAttachmentTooLargeError ? 413 : 400, { error: cause.message }))
  app.use('*', async (c, next) => {
    await next()
    c.header(controlPlaneResponseHeader, controlPlaneResponseValue)
    if (c.req.path !== visualizationPreviewPath) {
      // A separate CSP policy intersects existing policies instead of weakening their directives.
      c.header('Content-Security-Policy', "frame-ancestors 'none'", { append: true })
      c.header('X-Frame-Options', 'DENY')
    }
  })
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
        runtimeProtocolVersion: hostRuntimeProtocolVersion,
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
    const identity = auth.identity(request)
    if (identity) c.set('identity', identity)
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
    return identity ? host.withIdentity(identity, () => next()) : next()
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
            capabilities: { sshTunnelAuthV1: true },
          },
      result.cookie ? { 'Set-Cookie': result.cookie } : undefined,
    )
  })
  // 固定沙箱壳公开提供，不含会话、凭据或草图数据。内容仅由父页面通过端口传入。
  app.get(visualizationPreviewPath, () => visualizationPreviewResponse())
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
