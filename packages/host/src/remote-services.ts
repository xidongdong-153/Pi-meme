import { createHash } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import type { HostService, HostRpcResponse } from '@pi-meme/contracts/host'
import type { ConnectionCredentialStore } from './connection-credentials'
import { sessionCookieName } from './transport-auth'

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function projects(value: unknown): value is HostService['projects'] {
  return (
    Array.isArray(value) &&
    value.every(
      (item: unknown) =>
        record(item) &&
        typeof item.cwd === 'string' &&
        typeof item.name === 'string' &&
        typeof item.lastSelectedAt === 'string',
    )
  )
}
function summary(value: unknown) {
  return (
    record(value) &&
    ['id', 'path', 'cwd', 'created', 'modified'].every((key) => typeof value[key] === 'string') &&
    typeof value.messageCount === 'number'
  )
}
function sessions(value: unknown): value is NonNullable<HostService['sessions']> {
  return (
    record(value) &&
    Array.isArray(value.recents) &&
    value.recents.every(summary) &&
    Array.isArray(value.pinnedPaths) &&
    value.pinnedPaths.every((item: unknown) => typeof item === 'string') &&
    Array.isArray(value.projects) &&
    value.projects.every(
      (item: unknown) =>
        record(item) &&
        typeof item.cwd === 'string' &&
        typeof item.name === 'string' &&
        typeof item.sessionCount === 'number' &&
        typeof item.lastModified === 'string' &&
        Array.isArray(item.sessions) &&
        item.sessions.every(summary),
    ) &&
    (value.standaloneSessions === undefined ||
      (Array.isArray(value.standaloneSessions) && value.standaloneSessions.every(summary)))
  )
}
async function responseBody(response: Response, limit: number) {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > limit) throw new Error('远程响应超过大小限制')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export class RemoteServices {
  private readonly states = new Map<string, HostService>()
  private closing = false
  private readonly operations = new Set<Promise<unknown>>()
  private track<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('本机 Host 正在退出，远程服务操作未接纳'))
    const pending = Promise.resolve().then(action)
    this.operations.add(pending)
    void pending.finally(() => this.operations.delete(pending)).catch(() => {})
    return pending
  }
  assertIdle() {
    if (this.operations.size || this.authenticating.size)
      throw new Error('远程服务登记或摘要仍在处理，请稍后再维护存储')
  }
  prepareMaintenance() {
    this.assertIdle()
    this.closing = true
  }
  private readonly cookies = new Map<string, string>()
  private readonly authenticating = new Map<string, Promise<void>>()
  private writing = Promise.resolve()
  private damagedCache = false
  private readonly sockets = new Map<string, Set<WebSocket>>()
  private assertCurrent(state: HostService) {
    if (this.states.get(state.id) !== state) throw new Error('远程服务登记已变化')
  }
  private disconnect(id: string) {
    this.cookies.delete(id)
    for (const socket of this.sockets.get(id) ?? []) socket.terminate()
    this.sockets.delete(id)
  }
  constructor(
    private readonly connections: ConnectionCredentialStore,
    private readonly root: string,
  ) {}

  private id(url: string) {
    return createHash('sha256').update(url).digest('hex').slice(0, 24)
  }
  async initialize() {
    let cached: HostService[] = []
    let cacheError: string | undefined
    try {
      const source: unknown = JSON.parse(
        await readFile(path.join(this.root, 'remote-services.json'), 'utf8').catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === 'ENOENT') return '[]'
          throw cause
        }),
      )
      if (!Array.isArray(source)) throw new Error('服务摘要缓存格式无效')
      cached = source.filter(
        (item): item is HostService => record(item) && typeof item.id === 'string' && projects(item.projects),
      )
      for (const item of cached) if (item.sessions && !sessions(item.sessions)) delete item.sessions
    } catch {
      this.damagedCache = true
      cacheError = '远程服务摘要缓存无法读取，已保留原文件'
    }
    for (const saved of this.connections.list()) {
      const id = this.id(saved.url)
      const old = cached.find((service) => service.id === id)
      this.states.set(id, {
        id,
        hostId: saved.hostId,
        address: saved.url,
        local: false,
        status: 'disconnected',
        error: cacheError,
        projects: old?.projects ?? [],
        sessions: old?.sessions,
      })
    }
  }
  list() {
    return [...this.states.values()].map((state) => ({ ...state }))
  }
  private get(id: string) {
    const state = this.states.get(id)
    if (!state) throw new Error('远程服务未登记')
    return state
  }
  private save() {
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        const target = path.join(this.root, 'remote-services.json')
        if (this.damagedCache) {
          await rename(target, `${target}.invalid-${Date.now()}`).catch((cause: NodeJS.ErrnoException) => {
            if (cause.code !== 'ENOENT') throw cause
          })
          this.damagedCache = false
        }
        await writeFile(`${target}.tmp`, JSON.stringify(this.list()), { mode: 0o600 })
        await rename(`${target}.tmp`, target)
      })
    return this.writing
  }
  private async login(url: string, token: string, expected?: string) {
    const response = await fetch(new URL('/api/auth', url), {
      signal: AbortSignal.timeout(15000),
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ token }),
    })
    if (!response.ok) throw new Error('远程服务认证失败，请检查访问令牌')
    const value = JSON.parse((await responseBody(response, 64 * 1024)).toString()) as { hostId?: unknown }
    if (typeof value.hostId !== 'string' || !value.hostId || (expected && value.hostId !== expected))
      throw new Error('远程服务身份已变化，请重新登记')
    const cookies = response.headers.getSetCookie()
    const cookieName = sessionCookieName(value.hostId)
    const cookie = (
      cookies.find((cookie) => cookie.startsWith(`${cookieName}=`)) ??
      cookies.find((cookie) => cookie.startsWith('pi_meme_session='))
    )?.split(';')[0]
    if (!cookie) throw new Error('远程服务未返回认证会话')
    return { hostId: value.hostId, cookie }
  }
  register(url: string, token?: string) {
    return this.track(() => this.registerService(url, token))
  }
  private async registerService(url: string, token?: string) {
    const address = new URL(url)
    if (address.protocol !== 'https:' || address.username || address.password)
      throw new Error('远程服务必须使用 HTTPS，地址不能包含凭据')
    const saved = this.connections.read(address.origin)
    const credential = token || saved?.token
    if (!credential) throw new Error('请输入远程服务访问令牌')
    const result = await this.login(address.origin, credential, saved?.hostId)
    await this.connections.save({ url: address.origin, token: credential, hostId: result.hostId })
    const id = this.id(address.origin)
    const old = this.states.get(id)
    this.disconnect(id)
    this.authenticating.delete(id)
    this.states.set(id, {
      id,
      address: address.origin,
      hostId: result.hostId,
      local: false,
      status: 'connected',
      projects: old?.projects ?? [],
      sessions: old?.sessions,
    })
    this.cookies.set(id, result.cookie)
    await this.save()
    return this.get(id)
  }
  async authenticate(id: string) {
    if (this.closing) throw new Error('本机 Host 正在退出')
    const state = this.get(id)
    if (this.cookies.has(id)) return
    let pending = this.authenticating.get(id)
    if (!pending) {
      pending = (async () => {
        const saved = this.connections.read(state.address)
        if (!saved) throw new Error('远程服务凭据不存在')
        const result = await this.login(state.address, saved.token, state.hostId)
        this.assertCurrent(state)
        this.cookies.set(id, result.cookie)
        state.status = 'connected'
        delete state.error
      })().finally(() => {
        if (this.authenticating.get(id) === pending) this.authenticating.delete(id)
      })
      this.authenticating.set(id, pending)
    }
    await pending
  }
  retry(id: string) {
    return this.track(() => this.retryService(id))
  }
  private async retryService(id: string) {
    const state = this.get(id)
    this.cookies.delete(id)
    try {
      await this.authenticate(id)
    } catch (cause) {
      this.failed(id, cause, state)
      throw cause
    }
    return this.get(id)
  }
  remove(id: string) {
    return this.track(() => this.removeService(id))
  }
  removeSavedConnection(url: string) {
    return this.track(async () => {
      const service = [...this.states.values()].find((service) => service.address === new URL(url).origin)
      if (service) await this.removeService(service.id)
      else await this.connections.remove(url)
    })
  }
  private async removeService(id: string) {
    const state = this.get(id)
    await this.connections.remove(state.address)
    this.states.delete(id)
    this.authenticating.delete(id)
    this.disconnect(id)
    await this.save()
  }
  private failed(id: string, cause: unknown, expected?: HostService) {
    const state = this.states.get(id)
    if (state && (!expected || state === expected)) {
      state.status = 'disconnected'
      state.error = cause instanceof Error ? cause.message : String(cause)
      if (state.error.includes('身份已变化')) this.disconnect(id)
    }
  }
  uploadAttachment(
    id: string,
    metadata: URLSearchParams,
    body: ReadableStream<Uint8Array> | null,
    signal?: AbortSignal,
  ) {
    return this.track(async () => {
      const state = this.get(id)
      if (metadata.get('hostId') !== state.hostId) throw new Error('Host 身份不匹配')
      try {
        signal?.throwIfAborted()
        await this.authenticate(id)
        this.assertCurrent(state)
        signal?.throwIfAborted()
        const url = new URL('/api/chat/attachments', state.address)
        url.search = metadata.toString()
        const init: RequestInit & { duplex: 'half' } = {
          method: 'POST',
          redirect: 'error',
          headers: { Cookie: this.cookies.get(id)!, Origin: state.address, 'Content-Type': 'application/octet-stream' },
          body,
          duplex: 'half',
          signal,
        }
        const response = await fetch(url, init)
        this.assertCurrent(state)
        if (response.status === 401) {
          // 流不能重放；只续期认证，让持有原始 Blob 的客户端重建请求体。
          signal?.throwIfAborted()
          this.cookies.delete(id)
          await this.authenticate(id)
          this.assertCurrent(state)
        }
        const data = await responseBody(response, 64 * 1024)
        this.assertCurrent(state)
        if (response.ok && JSON.parse(data.toString()).hostId !== state.hostId) {
          this.disconnect(id)
          throw new Error('远程服务身份已变化')
        }
        return {
          status: response.status,
          contentType: response.headers.get('content-type') ?? 'application/json',
          data,
        }
      } catch (cause) {
        if (!signal?.aborted) this.failed(id, cause, state)
        throw cause
      }
    })
  }
  request(id: string, pathname: string, method: string, body?: string) {
    return this.track(() => this.proxyRequest(id, pathname, method, body))
  }
  private async proxyRequest(id: string, pathname: string, method: string, body?: string) {
    const state = this.get(id)
    if ((pathname === '/api/auth' || pathname === '/api/rpc' || pathname === '/api/control') && method !== 'POST')
      throw new Error('远程代理请求方法无效')
    if (pathname.startsWith('/api/plugins/') && method !== 'GET') throw new Error('远程资源请求方法无效')
    if (!(
      pathname === '/api/auth' ||
      pathname === '/api/rpc' ||
      pathname === '/api/control' ||
      pathname.startsWith('/api/plugins/')
    ))
      throw new Error('远程代理接口无效')
    try {
      await this.authenticate(id)
      this.assertCurrent(state)
      const send = () =>
        fetch(new URL(pathname, state.address), {
          signal: AbortSignal.timeout(30000),
          method,
          redirect: 'error',
          headers: { Cookie: this.cookies.get(id)!, Origin: state.address, 'Content-Type': 'application/json' },
          body,
        })
      if (pathname === '/api/auth')
        return {
          status: 200,
          contentType: 'application/json',
          data: Buffer.from(JSON.stringify({ hostId: state.hostId })),
        }
      let response = await send()
      this.assertCurrent(state)
      if (response.status === 401) {
        this.cookies.delete(id)
        await this.authenticate(id)
        this.assertCurrent(state)
        response = await send()
      }
      this.assertCurrent(state)
      let data = await responseBody(response, 48 * 1024 * 1024)
      this.assertCurrent(state)
      if (pathname === '/api/rpc' && response.ok) {
        const envelope = JSON.parse(data.toString()) as HostRpcResponse
        if (envelope.hostId !== state.hostId) {
          this.disconnect(id)
          throw new Error('远程服务身份已变化')
        }
        const request = JSON.parse(body!) as { method: string }
        if (!envelope.error && request.method === 'workspace:projects') {
          if (!projects(envelope.result)) throw new Error('远程项目摘要格式无效')
          state.projects = envelope.result
        }
        if (!envelope.error && request.method === 'pi:sessions') {
          if (!sessions(envelope.result)) throw new Error('远程会话摘要格式无效')
          state.sessions = envelope.result
        }
        const rewriteDescriptors = (value: unknown) => {
          if (!Array.isArray(value)) return value
          return value.map((item: unknown) => {
            if (!item || typeof item !== 'object') return item
            const descriptor = item as Record<string, unknown>
            const result = { ...descriptor }
            for (const field of ['ui', 'iconUrl']) {
              const value = descriptor[field]
              if (typeof value === 'string' && value.startsWith('/api/plugins/'))
                result[field] = `/api/services/${id}${value}`
            }
            return result
          })
        }
        if (request.method === 'plugins:list' || request.method === 'plugins:session')
          envelope.result = rewriteDescriptors(envelope.result)
        if (envelope.result && typeof envelope.result === 'object' && 'uiPlugins' in envelope.result)
          envelope.result = { ...envelope.result, uiPlugins: rewriteDescriptors(envelope.result.uiPlugins) }
        if (envelope.result && typeof envelope.result === 'object' && 'snapshot' in envelope.result) {
          const snapshot = envelope.result.snapshot
          if (snapshot && typeof snapshot === 'object' && 'uiPlugins' in snapshot)
            envelope.result = {
              ...envelope.result,
              snapshot: { ...snapshot, uiPlugins: rewriteDescriptors(snapshot.uiPlugins) },
            }
        }
        if (envelope.result && typeof envelope.result === 'object' && 'themes' in envelope.result) {
          const result = envelope.result as { themes?: Array<{ background?: { url?: string } }> }
          for (const theme of result.themes ?? [])
            if (theme.background?.url?.startsWith('/api/plugins/'))
              theme.background.url = `/api/services/${id}${theme.background.url}`
        }
        data = Buffer.from(JSON.stringify(envelope))
        if (!envelope.error && ['workspace:projects', 'pi:sessions'].includes(request.method)) await this.save()
      }
      return {
        status: response.status === 401 ? 403 : response.status,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        data,
      }
    } catch (cause) {
      this.failed(id, cause, state)
      throw cause
    }
  }
  async events(id: string, clientId: string, downstream: WebSocket, subscription?: string) {
    const state = this.get(id)
    await this.authenticate(id)
    this.assertCurrent(state)
    const url = new URL(subscription === undefined ? '/api/events' : '/api/control/events', state.address)
    if (subscription !== undefined) url.searchParams.set('subscription', subscription)
    url.protocol = 'wss:'
    url.searchParams.set('clientId', clientId)
    const connect = (renewed: boolean) => {
      this.assertCurrent(state)
      if (downstream.readyState !== WebSocket.OPEN) return
      const upstream = new WebSocket(url, {
        headers: { Cookie: this.cookies.get(id)!, Origin: state.address },
        followRedirects: false,
        handshakeTimeout: 15000,
        maxPayload: 48 * 1024 * 1024,
      })
      const active = this.sockets.get(id) ?? new Set<WebSocket>()
      active.add(upstream)
      this.sockets.set(id, active)
      let renewing = false
      const close = () => upstream.close()
      downstream.once('close', close)
      upstream.on('unexpected-response', (_request, response) => {
        response.resume()
        if (response.statusCode === 401 && !renewed) {
          renewing = true
          this.cookies.delete(id)
          upstream.terminate()
          void this.authenticate(id)
            .then(() => connect(true))
            .catch((cause) => {
              this.failed(id, cause, state)
              downstream.close(1011, '远程服务认证失败')
            })
        } else {
          upstream.terminate()
          downstream.close(1011, '远程服务订阅失败')
        }
      })
      upstream.on('error', (cause) => {
        if (!renewing) {
          this.failed(id, cause, state)
          downstream.close(1011, '远程服务连接失败')
        }
      })
      upstream.on('close', () => {
        active.delete(upstream)
        downstream.off('close', close)
        if (!renewing) downstream.close()
      })
      upstream.on('message', (data) => {
        try {
          this.assertCurrent(state)
          const event = JSON.parse(data.toString()) as { hostId?: string }
          if (event.hostId !== state.hostId) throw new Error('远程服务身份已变化')
          if (downstream.readyState === WebSocket.OPEN) downstream.send(data)
        } catch {
          this.disconnect(id)
          downstream.close(1011, '远程事件身份无效')
        }
      })
    }
    connect(false)
  }
  async flush() {
    await Promise.allSettled([...this.operations, ...this.authenticating.values()])
    await this.writing
  }
  dispose() {
    this.closing = true
    for (const id of this.states.keys()) this.disconnect(id)
    this.states.clear()
  }
}
