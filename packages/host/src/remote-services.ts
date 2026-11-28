import { createHash } from 'node:crypto'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import { isHostRpcRequest, isHostRpcResponse, type HostService } from '@pi-meme/contracts/host'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import type { ConnectionCredentialStore } from './connection-credentials'
import { sessionCookieName } from './transport-auth'
import { sshServiceStatus, type SshConnection } from '@pi-meme/contracts/ssh-connections'
import { SshConnections, type SshConnectionOptions } from './ssh-connections'
import { SshError } from './ssh-tunnels'
import { responseBody } from './response-body'

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

export class RemoteServices {
  private readonly states = new Map<string, HostService>()
  readonly ssh: SshConnections
  private cached: HostService[] = []
  private readonly listeners = new Set<() => void>()
  onChanged(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private changed() {
    for (const listener of this.listeners) listener()
  }
  private sshChanged(connection: SshConnection, endpoint?: string, cookie?: string) {
    if (!endpoint) {
      this.disconnect(connection.id)
    }
    if (connection.hostId) {
      const old =
        this.states.get(connection.id) ??
        this.cached.find((item) => item.id === connection.id && item.hostId === connection.hostId)
      const next: HostService = {
        id: connection.id,
        hostId: connection.hostId,
        address: `http://ssh-${connection.id}.invalid`,
        local: false,
        transport: 'ssh',
        name: connection.name,
        enabled: connection.enabled,
        phase: connection.phase,
        step: connection.step,
        errorCode: connection.errorCode,
        nextRetryAt: connection.nextRetryAt,
        error: connection.error,
        status: sshServiceStatus[connection.phase],
        projects: old?.projects ?? [],
        sessions: old?.sessions,
      }
      if (old?.phase === 'connected' && connection.phase === 'connected' && !cookie && endpoint)
        Object.assign(old, next)
      else this.states.set(connection.id, next)
      if (cookie) this.cookies.set(connection.id, cookie)
      void this.save().catch(() => {})
    }
    this.changed()
  }
  private endpoint(state: HostService) {
    return state.transport === 'ssh' ? this.ssh.endpoint(state.id) : state.address
  }
  private closing = false
  private readonly shutdown = new AbortController()
  private readonly registrations = new Map<string, Promise<unknown>>()
  private mutateRegistration<T>(id: string, action: () => Promise<T>) {
    const previous = this.registrations.get(id)
    const pending = this.track(async () => {
      await previous?.catch(() => {})
      this.shutdown.signal.throwIfAborted()
      return action()
    })
    this.registrations.set(id, pending)
    void pending
      .finally(() => {
        if (this.registrations.get(id) === pending) this.registrations.delete(id)
      })
      .catch(() => {})
    return pending
  }
  private readonly operations = new Set<Promise<unknown>>()
  private track<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('本机服务正在退出，远程服务操作未接纳'))
    const pending = Promise.resolve().then(action)
    this.operations.add(pending)
    void pending.finally(() => this.operations.delete(pending)).catch(() => {})
    return pending
  }
  assertIdle() {
    this.ssh.assertIdle()
    if (this.operations.size || this.authenticating.size)
      throw new Error('远程服务登记或摘要仍在处理，请稍后再维护存储')
  }
  prepareMaintenance() {
    this.assertIdle()
    this.closing = true
    this.ssh.dispose()
  }
  private readonly lifetimes = new Map<string, AbortController>()
  private readonly summaryReads = new WeakMap<HostService, Map<string, symbol>>()
  private readonly cookies = new Map<string, string>()
  private readonly authenticating = new Map<string, Promise<void>>()
  private writing = Promise.resolve()
  private damagedCache = false
  private readonly sockets = new Map<string, Set<WebSocket>>()
  private assertCurrent(state: HostService) {
    if (this.states.get(state.id) !== state) throw new Error('远程服务登记已变化')
    if (state.transport === 'ssh') this.endpoint(state)
  }
  private lifetime(id: string) {
    let controller = this.lifetimes.get(id)
    if (!controller) {
      controller = new AbortController()
      this.lifetimes.set(id, controller)
    }
    return controller.signal
  }
  private disconnect(id: string) {
    this.lifetimes.get(id)?.abort(new Error('远程服务连接已变化'))
    this.lifetimes.delete(id)
    this.authenticating.delete(id)
    this.cookies.delete(id)
    for (const socket of this.sockets.get(id) ?? []) socket.terminate()
    this.sockets.delete(id)
  }
  constructor(
    private readonly connections: ConnectionCredentialStore,
    private readonly root: string,
    sshOptions: SshConnectionOptions = {},
  ) {
    this.ssh = new SshConnections(
      root,
      connections,
      {
        login: (connection, endpoint, signal) => {
          const token = connections.readSsh(connection.id)
          if (!token) throw new SshError('host-token', '远程服务自动准备未返回访问令牌，请重试连接')
          return this.login(endpoint, token, connection.hostId, true, signal)
        },
        changed: (connection, endpoint, cookie) => this.sshChanged(connection, endpoint, cookie),
        removed: (id) => {
          this.disconnect(id)
          this.states.delete(id)
          void this.save().catch(() => {})
          this.changed()
        },
      },
      sshOptions,
    )
  }

  private id(url: string) {
    return createHash('sha256').update(url).digest('hex').slice(0, 24)
  }
  async initialize() {
    let cached: HostService[] = []
    let cacheError: string | undefined
    try {
      const source: unknown = JSON.parse(
        await readFile(path.join(this.root, storageLayoutRelativePaths.remoteServicesCacheFile), 'utf8').catch(
          (cause: NodeJS.ErrnoException) => {
            if (cause.code === 'ENOENT') return '[]'
            throw cause
          },
        ),
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
    this.cached = cached
    for (const saved of this.connections.list()) {
      const id = this.id(saved.url)
      const old = cached.find((service) => service.id === id && service.hostId === saved.hostId)
      this.states.set(id, {
        id,
        hostId: saved.hostId,
        address: saved.url,
        local: false,
        status: 'disconnected',
        error: cacheError,
        projects: old?.projects ?? [],
        sessions: old?.sessions,
        transport: 'https',
      })
    }
    await this.ssh.initialize()
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
        const target = path.join(this.root, storageLayoutRelativePaths.remoteServicesCacheFile)
        await mkdir(path.dirname(target), { recursive: true })
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
  private async login(url: string, token: string, expected?: string, ssh = false, signal?: AbortSignal) {
    const response = await fetch(new URL('/api/auth', url), {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ token }),
    })
    if (!response.ok) throw new SshError('host-auth', '远程服务认证失败，请检查访问令牌')
    const value = JSON.parse((await responseBody(response, 64 * 1024)).toString()) as {
      hostId?: unknown
      authMode?: unknown
      capabilities?: { sshTunnelAuth?: unknown }
    }
    if (ssh && value.capabilities?.sshTunnelAuth !== true)
      throw new SshError('host-upgrade', '远程服务不支持安全 SSH 连接，请先升级服务')
    if (ssh && value.authMode !== 'token-required')
      throw new SshError('host-auth-mode', '远程服务必须以 PI_MEME_AUTH_MODE=token-required 模式启动')
    if (typeof value.hostId !== 'string' || !value.hostId || (expected && value.hostId !== expected))
      throw new SshError('host-identity', '远程服务身份已变化，请重新登记')
    const cookies = response.headers.getSetCookie()
    const cookieName = sessionCookieName(value.hostId)
    const cookie = (
      cookies.find((cookie) => cookie.startsWith(`${cookieName}=`)) ??
      cookies.find((cookie) => cookie.startsWith('pi_meme_session='))
    )?.split(';')[0]
    if (!cookie) throw new SshError('host-session', '远程服务未返回认证会话')
    return { hostId: value.hostId, cookie }
  }
  async register(url: string, token?: string) {
    const address = new URL(url)
    if (address.protocol !== 'https:' || address.username || address.password)
      throw new Error('远程服务必须使用 HTTPS，地址不能包含凭据')
    const id = this.id(address.origin)
    return this.mutateRegistration(id, () => this.registerService(id, address.origin, token))
  }
  private async registerService(id: string, url: string, token?: string) {
    const saved = this.connections.read(url)
    const credential = token || saved?.token
    if (!credential) throw new Error('请输入远程服务访问令牌')
    const result = await this.login(url, credential, saved?.hostId, false, this.shutdown.signal)
    this.shutdown.signal.throwIfAborted()
    await this.connections.save({ url, token: credential, hostId: result.hostId })
    this.shutdown.signal.throwIfAborted()
    const old = this.states.get(id)
    this.disconnect(id)
    this.states.set(id, {
      id,
      address: url,
      hostId: result.hostId,
      local: false,
      transport: 'https',
      status: 'connected',
      projects: old?.projects ?? [],
      sessions: old?.sessions,
    })
    this.cookies.set(id, result.cookie)
    this.changed()
    await this.save()
    return { ...this.get(id) }
  }
  async authenticate(id: string) {
    if (this.closing) throw new Error('本机服务正在退出')
    const state = this.get(id)
    const endpoint = this.endpoint(state)
    if (this.cookies.has(id)) return
    let pending = this.authenticating.get(id)
    if (!pending) {
      const signal = this.lifetime(id)
      this.httpsStatus(state, 'connecting')
      pending = (async () => {
        const token =
          state.transport === 'ssh' ? this.connections.readSsh(id) : this.connections.read(state.address)?.token
        if (!token) throw new Error('远程服务凭据不存在')
        const result = await this.login(endpoint, token, state.hostId, state.transport === 'ssh', signal)
        signal.throwIfAborted()
        this.assertCurrent(state)
        this.cookies.set(id, result.cookie)
        this.httpsStatus(state, 'connected')
      })()
        .catch((cause) => {
          if (!signal.aborted) this.failed(id, cause, state)
          throw cause
        })
        .finally(() => {
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
    if (this.ssh.has(id)) throw new Error('SSH 连接请使用 SSH 管理入口重试')
    const state = this.get(id)
    if (!this.authenticating.has(id)) this.cookies.delete(id)
    await this.authenticate(id)
    this.assertCurrent(state)
    return { ...state }
  }
  remove(id: string) {
    return this.mutateRegistration(id, () => this.removeService(id))
  }
  async removeSavedConnection(url: string) {
    const id = this.id(new URL(url).origin)
    return this.mutateRegistration(id, async () => {
      if (this.states.has(id)) await this.removeService(id)
      else await this.connections.remove(url)
    })
  }
  private async removeService(id: string) {
    if (this.ssh.has(id)) throw new Error('SSH 连接请使用 SSH 管理入口移除')
    const state = this.get(id)
    await this.connections.remove(state.address)
    this.states.delete(id)
    this.disconnect(id)
    this.changed()
    await this.save()
  }
  private httpsStatus(state: HostService, status: HostService['status'], error?: string) {
    if (state.transport === 'ssh' || this.states.get(state.id) !== state) return
    if (state.status === status && state.error === error) return
    state.status = status
    state.error = error
    this.changed()
  }
  private failed(id: string, cause: unknown, expected?: HostService) {
    const state = this.states.get(id)
    if (state && (!expected || state === expected)) {
      const error = cause instanceof Error ? cause.message : String(cause)
      if (error.includes('身份已变化')) this.disconnect(id)
      if (state.transport === 'ssh') this.ssh.connectionFailed(id, cause)
      else this.httpsStatus(state, 'disconnected', error)
    }
  }
  uploadAttachment(
    id: string,
    metadata: URLSearchParams,
    body: ReadableStream<Uint8Array> | null,
    signal?: AbortSignal,
  ) {
    return this.uploadBinary('/api/chat/attachments', id, metadata, body, signal)
  }
  uploadImage(id: string, metadata: URLSearchParams, body: ReadableStream<Uint8Array> | null, signal?: AbortSignal) {
    return this.uploadBinary('/api/images/upload', id, metadata, body, signal)
  }
  private uploadBinary(
    pathname: '/api/chat/attachments' | '/api/images/upload',
    id: string,
    metadata: URLSearchParams,
    body: ReadableStream<Uint8Array> | null,
    signal?: AbortSignal,
  ) {
    return this.track(async () => {
      const state = this.get(id)
      if (metadata.get('hostId') !== state.hostId) throw new Error('服务身份不匹配')
      const lifetime = this.lifetime(id)
      const active = signal ? AbortSignal.any([lifetime, signal]) : lifetime
      try {
        active.throwIfAborted()
        await this.authenticate(id)
        this.assertCurrent(state)
        active.throwIfAborted()
        const cookie = this.cookies.get(id)!
        const endpoint = this.endpoint(state)
        const url = new URL(pathname, endpoint)
        url.search = metadata.toString()
        const init: RequestInit & { duplex: 'half' } = {
          method: 'POST',
          redirect: 'error',
          headers: { Cookie: cookie, Origin: endpoint, 'Content-Type': 'application/octet-stream' },
          body,
          duplex: 'half',
          signal: active,
        }
        const response = await fetch(url, init)
        this.assertCurrent(state)
        if (response.status === 401) {
          // 流不能重放；只续期认证，让持有原始 Blob 的客户端重建请求体。
          active.throwIfAborted()
          if (this.cookies.get(id) === cookie) this.cookies.delete(id)
          await this.authenticate(id)
          this.assertCurrent(state)
        }
        const data = await responseBody(response, 64 * 1024)
        this.assertCurrent(state)
        active.throwIfAborted()
        if (response.ok) {
          if (JSON.parse(data.toString()).hostId !== state.hostId)
            throw new SshError('host-identity', '远程服务身份已变化')
          this.httpsStatus(state, 'connected')
        }
        return {
          status: response.status,
          contentType: response.headers.get('content-type') ?? 'application/json',
          data,
        }
      } catch (cause) {
        if (!active.aborted) this.failed(id, cause, state)
        throw cause
      }
    })
  }
  request(id: string, pathname: string, method: string, body?: string, signal?: AbortSignal) {
    return this.track(() => this.proxyRequest(id, pathname, method, body, signal))
  }
  private async proxyRequest(id: string, pathname: string, method: string, body?: string, signal?: AbortSignal) {
    const state = this.get(id)
    const post = ['/api/auth', '/api/rpc', '/api/control', '/api/update/check'].includes(pathname)
    const get = pathname === '/api/update' || pathname.startsWith('/api/plugins/')
    if (!post && !get) throw new Error('远程代理接口无效')
    if (post && method !== 'POST') throw new Error('远程代理请求方法无效')
    if (get && method !== 'GET') throw new Error('远程资源请求方法无效')
    let rpc: import('@pi-meme/contracts/host').HostRpcRequest | undefined
    if (pathname === '/api/rpc') {
      const input: unknown = JSON.parse(body ?? '{}')
      if (!isHostRpcRequest(input)) throw new Error('远程 RPC 请求参数无效')
      rpc = input
      if (
        rpc.method.startsWith('host:ssh:') ||
        ['host:services:retry', 'host:services:remove', 'host:connections:remove'].includes(rpc.method)
      )
        throw new Error('远程代理不允许转发连接管理请求')
    }
    const lifetime = this.lifetime(id)
    const active = signal ? AbortSignal.any([lifetime, signal]) : lifetime
    const summary = rpc?.method === 'workspace:projects' || rpc?.method === 'pi:sessions' ? rpc.method : undefined
    const generation = Symbol(rpc?.requestId)
    if (summary) {
      const reads = this.summaryReads.get(state) ?? new Map<string, symbol>()
      reads.set(summary, generation)
      this.summaryReads.set(state, reads)
    }
    try {
      active.throwIfAborted()
      await this.authenticate(id)
      active.throwIfAborted()
      this.assertCurrent(state)
      const endpoint = this.endpoint(state)
      const send = (cookie: string) =>
        fetch(new URL(pathname, endpoint), {
          signal: AbortSignal.any([active, AbortSignal.timeout(30000)]),
          method,
          redirect: 'error',
          headers: { Cookie: cookie, Origin: endpoint, 'Content-Type': 'application/json' },
          body,
        })
      if (pathname === '/api/auth')
        return {
          status: 200,
          contentType: 'application/json',
          data: Buffer.from(JSON.stringify({ hostId: state.hostId })),
        }
      const cookie = this.cookies.get(id)!
      let response = await send(cookie)
      active.throwIfAborted()
      this.assertCurrent(state)
      if (response.status === 401) {
        if (this.cookies.get(id) === cookie) this.cookies.delete(id)
        await this.authenticate(id)
        active.throwIfAborted()
        this.assertCurrent(state)
        response = await send(this.cookies.get(id)!)
      }
      this.assertCurrent(state)
      const update = pathname === '/api/update' || pathname === '/api/update/check'
      let data = await responseBody(response, update ? 256 * 1024 : 48 * 1024 * 1024)
      this.assertCurrent(state)
      active.throwIfAborted()
      if (response.ok && (pathname === '/api/rpc' || update)) {
        const envelope: unknown = JSON.parse(data.toString())
        if (!record(envelope) || envelope.hostId !== state.hostId)
          throw new SshError('host-identity', '远程服务身份已变化')
        if (update) {
          this.httpsStatus(state, 'connected')
          return { status: response.status, contentType: 'application/json', data }
        }
        if (!isHostRpcResponse(envelope) || !rpc || envelope.requestId !== rpc.requestId)
          throw new Error('远程服务返回的 RPC 回执格式或请求标识无效')
        active.throwIfAborted()
        const currentSummary = summary && this.summaryReads.get(state)?.get(summary) === generation
        if (!envelope.error && rpc.method === 'workspace:projects') {
          if (!projects(envelope.result)) throw new Error('远程项目摘要格式无效')
          if (currentSummary) state.projects = envelope.result
        }
        if (!envelope.error && rpc.method === 'pi:sessions') {
          if (!sessions(envelope.result)) throw new Error('远程会话摘要格式无效')
          if (currentSummary) state.sessions = envelope.result
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
        if (rpc.method === 'plugins:list' || rpc.method === 'plugins:session')
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
        if (!envelope.error && currentSummary) await this.save()
      }
      active.throwIfAborted()
      if (response.ok) this.httpsStatus(state, 'connected')
      return {
        status: response.status === 401 ? 403 : response.status,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        data,
      }
    } catch (cause) {
      if (!active.aborted) this.failed(id, cause, state)
      throw cause
    }
  }
  async events(id: string, clientId: string, downstream: WebSocket, subscription?: string, connectionId?: string) {
    const state = this.get(id)
    await this.authenticate(id)
    this.assertCurrent(state)
    const endpoint = this.endpoint(state)
    const url = new URL(subscription === undefined ? '/api/events' : '/api/control/events', endpoint)
    if (subscription !== undefined) url.searchParams.set('subscription', subscription)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('clientId', clientId)
    if (connectionId) url.searchParams.set('connectionId', connectionId)
    const connect = (renewed: boolean) => {
      this.assertCurrent(state)
      if (downstream.readyState !== WebSocket.OPEN) return
      const cookie = this.cookies.get(id)!
      const upstream = new WebSocket(url, {
        headers: { Cookie: cookie, Origin: endpoint },
        followRedirects: false,
        handshakeTimeout: 15000,
        maxPayload: 48 * 1024 * 1024,
      })
      const active = this.sockets.get(id) ?? new Set<WebSocket>()
      active.add(upstream)
      this.sockets.set(id, active)
      let renewing = false
      const close = () => upstream.close()
      upstream.once('open', () => this.httpsStatus(state, 'connected'))
      downstream.once('close', close)
      upstream.on('unexpected-response', (_request, response) => {
        response.resume()
        if (this.states.get(id) !== state) {
          upstream.terminate()
          downstream.close(1011, '远程服务登记已变化')
          return
        }
        if (response.statusCode === 401 && !renewed) {
          renewing = true
          if (this.cookies.get(id) === cookie) this.cookies.delete(id)
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
        if (!renewing && downstream.readyState === WebSocket.OPEN) {
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
          const text = data.toString()
          const event = JSON.parse(text) as { hostId?: string }
          if (event.hostId !== state.hostId) throw new SshError('host-identity', '远程服务身份已变化')
          if (downstream.readyState === WebSocket.OPEN) downstream.send(text)
        } catch (cause) {
          if (this.states.get(id) === state) {
            this.failed(id, cause, state)
            this.disconnect(id)
          } else upstream.terminate()
          downstream.close(1011, '远程事件身份无效')
        }
      })
    }
    connect(false)
  }
  async flush() {
    await this.ssh.flush()
    await Promise.allSettled([...this.operations, ...this.authenticating.values()])
    await this.writing
  }
  dispose() {
    this.closing = true
    this.shutdown.abort(new Error('本机服务正在退出'))
    this.ssh.dispose()
    for (const id of this.states.keys()) this.disconnect(id)
    this.states.clear()
  }
}
