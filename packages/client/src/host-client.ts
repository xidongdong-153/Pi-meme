import type {
  HostApi,
  HostControlResponse,
  EventSubscription,
  EventCursor,
  HostControlEvent,
} from '@pi-meme/contracts/app-host'
import { createAppHostClient } from './app-host-client'
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  type ChatFileUpload,
  type ChatUploadedFile,
} from '@pi-meme/contracts/chat-attachments'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import type {
  Connection,
  DesktopBridge,
  DesktopError,
  DesktopEvent,
  Snapshot,
  WorkspaceDeletionResult,
} from '@pi-meme/contracts/desktop'
import type {
  HostConnection,
  HostDirectory,
  HostEvent,
  HostRpcResponse,
  PlatformAdapter,
} from '@pi-meme/contracts/host'
import type { SettingsSnapshot, Theme } from '@pi-meme/contracts/settings'
import type { PluginClient } from './plugin-client'
import { createResourceClient, type ResourceClient } from './resource-client'

export type ClientOptions = {
  connection: HostConnection
  endpoint?: { baseUrl: string; apiPrefix: string; authenticate?: boolean; renewAuthentication?: () => Promise<void> }
  clientId?: string
  platform?: PlatformAdapter
  selectDirectory: (load: (path?: string) => Promise<HostDirectory>) => Promise<string | null>
  fetch?: typeof fetch
  createSocket?: (url: string) => WebSocket
  reconnectDelay?: number
}

function clientIdentity(options: ClientOptions, endpoint: URL) {
  if (options.clientId !== undefined) return options.clientId
  const fresh = () => crypto.randomUUID()
  if (typeof window === 'undefined') return fresh()
  try {
    const key = `pi-meme:client:${JSON.stringify([
      new URL(options.connection.url).origin,
      options.connection.hostId,
      new URL(`${options.endpoint?.apiPrefix ?? ''}/api/rpc`, endpoint).href,
    ])}`
    const stored = window.sessionStorage.getItem(key)
    if (stored && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stored)) return stored
    const id = fresh()
    window.sessionStorage.setItem(key, id)
    return id
  } catch {
    return fresh()
  }
}

const previewableImageExtensions = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i
const imageMimeExtensions: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/svg+xml': '.svg',
  'image/svg': '.svg',
}

function normalizeAttachmentInput(input: ChatFileUpload): ChatFileUpload {
  const mime = input.data.type?.toLowerCase()
  const standardExt = mime ? imageMimeExtensions[mime] : undefined
  if (!standardExt) return input
  const name = input.name.trim()
  if (previewableImageExtensions.test(name)) return name === input.name ? input : { ...input, name }
  const base = name || 'image'
  const normalizedName = base.endsWith('.') ? `${base.slice(0, -1)}${standardExt}` : `${base}${standardExt}`
  return { ...input, name: normalizedName }
}

function isPreviewableImage(input: ChatFileUpload) {
  const name = input.name || (typeof File !== 'undefined' && input.data instanceof File ? input.data.name : '')
  if (previewableImageExtensions.test(name)) return true
  const mime = input.data.type?.toLowerCase()
  return Boolean(mime && mime in imageMimeExtensions)
}

export class HostClient {
  readonly clientId: string
  readonly host: HostApi
  private readonly controlSubscriptions = new Set<{
    suspend: () => void
    resume: () => Promise<void>
    close: () => void
  }>()
  readonly bridge: DesktopBridge
  readonly plugins: PluginClient
  readonly resources: ResourceClient
  private readonly url: URL
  private readonly fetch: typeof fetch
  private readonly eventListeners = new Set<(value: DesktopEvent) => void>()
  private readonly connectionListeners = new Set<(value: Connection) => void>()
  private readonly scopedConnectionListeners = new Map<string, Set<(value: Connection) => void>>()
  private readonly errorListeners = new Set<(value: DesktopError) => void>()
  private readonly sessionsListeners = new Set<() => void>()
  private readonly servicesListeners = new Set<() => void>()
  private readonly pluginListeners = new Set<() => void>()
  private socket?: WebSocket
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectAttempts = 0
  private closed = false
  private suspended = false
  private networkEpoch = 0
  private lifetime = new AbortController()
  private authenticated?: Promise<void>
  private renewing?: Promise<void>
  private selected?: Connection
  private selectionEpoch = 0
  private pendingSelections = 0
  private connectedHostId: string
  private readonly childAgents = new Map<string, string>()
  private readonly childReads = new Map<string, Promise<Snapshot>>()
  private readonly executionGenerations = new Map<string, number>()
  private readonly sequences = new Map<string, number>()
  private resynchronizing?: Promise<void>
  private buffered: HostEvent[] = []
  private readonly queueRecoveryComplete = new Set<string>()
  private readonly initialQueueRecovery = new Map<string, Promise<boolean>>()

  constructor(private readonly options: ClientOptions) {
    this.url = new URL(options.endpoint?.baseUrl ?? options.connection.url)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(this.url.hostname)
    if (this.url.protocol !== 'https:' && !(loopback && this.url.protocol === 'http:'))
      throw new Error('远程 Host 必须使用 HTTPS 地址')
    if (this.url.username || this.url.password) throw new Error('Host 地址不能包含账号或凭据')
    this.connectedHostId = options.connection.hostId
    this.clientId = clientIdentity(options, this.url)
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.host = createAppHostClient({ call: this.controlCall.bind(this), subscribe: this.subscribeControl.bind(this) })
    this.bridge = this.createBridge()
    this.resources = createResourceClient(this.rpc.bind(this), (callback) => {
      this.pluginListeners.add(callback)
      return () => {
        this.pluginListeners.delete(callback)
      }
    })
    this.plugins = {
      list: () => this.rpc('plugins:list', [], null),
      setGrant: (id, update) => this.rpc('plugins:set-grant', [id, update], null),
      callOperation: async (request, signal) => {
        const cancel = () => {
          void this.rpc('plugins:call-cancel', [request.requestId], null).catch(() => {})
        }
        signal?.throwIfAborted()
        signal?.addEventListener('abort', cancel, { once: true })
        try {
          return await this.rpc('plugins:call', [request], null, signal)
        } finally {
          signal?.removeEventListener('abort', cancel)
        }
      },
      acquireUiLease: (input) => this.rpc('plugins:ui-lease-acquire', [input], null),
      renewUiLease: (id) => this.rpc('plugins:ui-lease-renew', [id], null),
      releaseUiLease: (id) => this.rpc('plugins:ui-lease-release', [id], null),
      listCredentials: (id) => this.rpc('plugins:credential-list', [id], null),
      setCredential: (id, input) => this.rpc('plugins:credential-set', [id, input], null),
      removeCredential: (id, credentialId) => this.rpc('plugins:credential-remove', [id, credentialId], null),
      installDirectory: (path) => this.rpc('plugins:install-directory', [path], null),
      installPackage: (base64) => this.rpc('plugins:install-package', [base64], null),
      reload: (id) => this.rpc('plugins:reload', [id], null),
      enable: (id) => this.rpc('plugins:enable', [id], null),
      disable: (id) => this.rpc('plugins:disable', [id], null),
      remove: (id) => this.rpc('plugins:remove', [id], null),
      onChange: (callback) => {
        this.pluginListeners.add(callback)
        return () => {
          this.pluginListeners.delete(callback)
        }
      },
    }
  }

  get hostId() {
    return this.connectedHostId
  }
  get hostAddress() {
    return this.options.connection.url
  }
  get localHost() {
    return this.options.endpoint || this.options.platform
      ? this.options.connection.local
      : ['localhost', '127.0.0.1', '[::1]'].includes(this.url.hostname)
  }
  get nativePlatformAvailable() {
    return Boolean(this.options.connection.local && this.options.platform)
  }

  private assertAvailable(epoch = this.networkEpoch) {
    if (this.closed) throw new Error('Host 客户端已关闭')
    if (this.suspended) throw new Error('Host 连接已暂停，请恢复连接后继续')
    if (epoch !== this.networkEpoch) throw new Error('Host 连接已变化，旧操作结果已忽略')
  }

  onServicesChanged(callback: () => void) {
    this.servicesListeners.add(callback)
    return () => {
      this.servicesListeners.delete(callback)
    }
  }

  suspend(reason = 'Host 连接已暂停，请恢复连接后继续') {
    if (this.closed || this.suspended) return
    this.suspended = true
    this.networkEpoch++
    this.selectionEpoch++
    this.lifetime.abort(new Error(reason))
    this.authenticated = undefined
    this.renewing = undefined
    this.resynchronizing = undefined
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const socket = this.socket
    this.socket = undefined
    socket?.close()
    for (const subscription of this.controlSubscriptions) subscription.suspend()
    this.buffered = []
    if (this.selected) this.publishConnection({ ...this.selected, status: 'disconnected', error: reason })
  }

  async resume() {
    if (this.closed) throw new Error('Host 客户端已关闭')
    const wasSuspended = this.suspended
    if (wasSuspended) {
      this.suspended = false
      this.lifetime = new AbortController()
      this.reconnectAttempts = 0
    }
    await this.connect()
    if (wasSuspended) await Promise.all([...this.controlSubscriptions].map((subscription) => subscription.resume()))
  }

  async connect() {
    const epoch = this.networkEpoch
    this.assertAvailable(epoch)
    await this.authenticate()
    this.assertAvailable(epoch)
    this.openSocket()
  }

  resourceUrl(path: string) {
    return path.startsWith(`${this.options.endpoint?.apiPrefix ?? '/__unused__'}/api/`)
      ? new URL(path, this.url).href
      : this.endpoint(path).href
  }

  private endpoint(path: string) {
    return new URL(`${this.options.endpoint?.apiPrefix ?? ''}${path}`, this.url)
  }

  private authenticate() {
    this.assertAvailable()
    if (this.options.endpoint?.authenticate === false) return Promise.resolve()
    if (this.authenticated) return this.authenticated
    const epoch = this.networkEpoch
    const pending = (async () => {
      let response: Response
      try {
        response = await this.fetch(this.endpoint('/api/auth'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          signal: this.lifetime.signal,
          body: JSON.stringify({ token: this.options.connection.token }),
        })
      } catch (cause) {
        throw new Error('无法连接 Host，请启动 Desktop 或 pnpm start:server', { cause })
      }
      if (response.status === 502 || response.status === 503) {
        const value: unknown = await response.json().catch(() => undefined)
        const message = value && typeof value === 'object' && 'error' in value ? value.error : undefined
        throw new Error(
          typeof message === 'string' ? message : 'Host 未启动或尚未就绪，请启动 Desktop 或 pnpm start:server',
        )
      }
      this.assertAvailable(epoch)
      if (!response.ok) throw new Error('Host 认证失败，请检查访问令牌')
      const identity = (await response.json()) as { hostId?: unknown }
      this.assertAvailable(epoch)
      if (typeof identity.hostId !== 'string' || !identity.hostId) throw new Error('Host 没有返回有效身份')
      this.acceptHost(identity.hostId)
      this.options.connection.token = ''
    })().catch((error: unknown) => {
      if (this.authenticated === pending) this.authenticated = undefined
      throw error
    })
    this.authenticated = pending
    return pending
  }

  reauthenticate() {
    return this.renewAuthentication()
  }

  private renewAuthentication() {
    this.assertAvailable()
    if (this.renewing) return this.renewing
    const epoch = this.networkEpoch
    const pending = (async () => {
      this.authenticated = undefined
      if (this.options.endpoint?.renewAuthentication) await this.options.endpoint.renewAuthentication()
      else if (this.options.platform) {
        const connection = await this.options.platform.getHostConnection()
        this.assertAvailable(epoch)
        if (
          new URL(connection.url).origin !== this.url.origin ||
          (this.hostId && connection.hostId && this.hostId !== connection.hostId)
        )
          throw new Error('Host 连接已变化，请重新连接')
        this.options.connection.token = connection.token
      }
      this.assertAvailable(epoch)
      await this.authenticate()
      this.assertAvailable(epoch)
    })().finally(() => {
      if (this.renewing === pending) this.renewing = undefined
    })
    this.renewing = pending
    return pending
  }

  async rpc<T>(
    method: string,
    args: unknown[] = [],
    sessionId: string | null | undefined = this.selected?.sessionKey,
    signal?: AbortSignal,
  ): Promise<T> {
    const epoch = this.networkEpoch
    this.assertAvailable(epoch)
    const requestSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    await this.authenticate()
    this.assertAvailable(epoch)
    const requestId = crypto.randomUUID()
    const send = async () => {
      this.assertAvailable(epoch)
      try {
        return await this.fetch(this.endpoint('/api/rpc'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          signal: requestSignal,
          body: JSON.stringify({
            requestId,
            clientId: this.clientId,
            hostId: this.hostId || undefined,
            sessionId: sessionId ?? undefined,
            method,
            args,
          }),
        })
      } catch (cause) {
        this.assertAvailable(epoch)
        throw new Error(`无法连接 Host，操作没有自动重发：${String(cause)}`)
      }
    }
    let response = await send()
    this.assertAvailable(epoch)
    if (response.status === 401) {
      await this.renewAuthentication()
      this.assertAvailable(epoch)
      response = await send()
    }
    this.assertAvailable(epoch)
    if (response.status === 401) throw new Error('Host 登录已失效，请重新连接')
    const value: unknown = await response.json()
    this.assertAvailable(epoch)
    if (!value || typeof value !== 'object' || !('requestId' in value)) {
      const error = value && typeof value === 'object' && 'error' in value ? value.error : undefined
      throw new Error(typeof error === 'string' ? error : `Host 请求失败：HTTP ${response.status}`)
    }
    const envelope = value as HostRpcResponse
    if (envelope.requestId !== requestId) throw new Error('Host 返回了不匹配的请求标识')
    this.acceptHost(envelope.hostId)
    if (envelope.error) throw Object.assign(new Error(envelope.error.message), { code: envelope.error.code })
    if (!response.ok) throw new Error(`Host 请求失败：HTTP ${response.status}`)
    return envelope.result as T
  }

  private async uploadAttachment(
    sessionKey: string,
    rawInput: ChatFileUpload,
    signal?: AbortSignal,
    onProgress?: (percent: number) => void,
  ): Promise<ChatUploadedFile> {
    const input = normalizeAttachmentInput(rawInput)
    const epoch = this.networkEpoch
    this.assertAvailable(epoch)
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    signal.throwIfAborted()
    if (
      this.nativePlatformAvailable &&
      typeof File !== 'undefined' &&
      input.data instanceof File &&
      !isPreviewableImage(input)
    ) {
      const path = this.options.platform?.getPathForFile?.(input.data)
      if (path) return { name: input.name, path }
    }
    if (input.data.size > MAX_CHAT_ATTACHMENT_BYTES) throw new Error('单个上传文件不能超过 50 MB')
    await this.authenticate()
    this.assertAvailable(epoch)
    const url = this.endpoint('/api/chat/attachments')
    url.search = new URLSearchParams({
      sessionKey,
      clientId: this.clientId,
      hostId: this.hostId,
      name: input.name,
    }).toString()
    const send = () => {
      this.assertAvailable(epoch)
      signal?.throwIfAborted()
      if (typeof XMLHttpRequest === 'undefined') {
        return this.fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: input.data,
          signal,
        })
      }
      return new Promise<Response>((resolve, reject) => {
        const request = new XMLHttpRequest()
        const cleanup = () => {
          signal?.removeEventListener('abort', abort)
          request.upload.onprogress = null
          request.onload = null
          request.onerror = null
          request.onabort = null
        }
        const fail = (error: unknown) => {
          cleanup()
          reject(error)
        }
        function abort() {
          request.abort()
          fail(signal?.reason ?? new DOMException('附件上传已取消', 'AbortError'))
        }
        request.open('POST', url.href)
        request.withCredentials = true
        request.setRequestHeader('Content-Type', 'application/octet-stream')
        request.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0)
            onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)))
        }
        request.onload = () => {
          cleanup()
          resolve(new Response(request.responseText, { status: request.status }))
        }
        request.onerror = () => fail(new Error('附件上传失败，请检查网络连接'))
        request.onabort = () => fail(signal?.reason ?? new DOMException('附件上传已取消', 'AbortError'))
        signal?.addEventListener('abort', abort, { once: true })
        request.send(input.data)
      })
    }
    let response = await send()
    this.assertAvailable(epoch)
    if (response.status === 401) {
      signal?.throwIfAborted()
      await this.renewAuthentication()
      this.assertAvailable(epoch)
      response = await send()
    }
    const value = (await response.json()) as { hostId?: string; result?: ChatUploadedFile; error?: string }
    this.assertAvailable(epoch)
    if (!response.ok) throw new Error(value.error ?? `附件上传失败：HTTP ${response.status}`)
    this.acceptHost(value.hostId ?? '')
    if (!value.result || typeof value.result.path !== 'string' || typeof value.result.name !== 'string')
      throw new Error('Host 返回的附件信息无效')
    return value.result
  }

  private async controlCall<T>(method: string, args: unknown[], idempotencyKey?: string): Promise<T> {
    const epoch = this.networkEpoch
    this.assertAvailable(epoch)
    await this.authenticate()
    this.assertAvailable(epoch)
    const body = JSON.stringify({
      apiVersion: 2,
      hostId: this.connectedHostId,
      clientId: this.clientId,
      method,
      args,
      idempotencyKey,
    })
    const send = () => {
      this.assertAvailable(epoch)
      return this.fetch(this.endpoint('/api/control'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: this.lifetime.signal,
      })
    }
    let response = await send()
    this.assertAvailable(epoch)
    if (response.status === 401) {
      await this.renewAuthentication()
      this.assertAvailable(epoch)
      response = await send()
    }
    this.assertAvailable(epoch)
    if (!response.ok) throw new Error(`Host 请求失败：HTTP ${response.status}`)
    const value = (await response.json()) as HostControlResponse
    this.assertAvailable(epoch)
    this.acceptHost(value.hostId)
    if (value.error) throw Object.assign(new Error(value.error.message), { code: value.error.code })
    return value.result as T
  }

  private async subscribeControl(input: EventSubscription, listener: (event: HostControlEvent) => void) {
    if (this.closed) throw new Error('Host 客户端已关闭')
    let stopped = false
    let after: EventCursor | undefined = input.after
    let socket: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let connecting: Promise<void> | undefined
    const active = () => !stopped && !this.closed && !this.suspended
    const connection = (reason: 'connected' | 'disconnected') => {
      if (!active()) return
      listener({
        stream: 'live',
        type: 'resync',
        hostId: this.connectedHostId,
        sessionId: input.sessionId,
        eventId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        journalEpoch: after?.journalEpoch ?? '',
        seq: after?.seq ?? 0,
        value: { reason },
      })
    }
    const schedule = (start: () => Promise<void>) => {
      if (!active() || timer) return
      timer = setTimeout(() => {
        timer = undefined
        void start().catch(() => {
          connection('disconnected')
          schedule(start)
        })
      }, this.options.reconnectDelay ?? 1000)
    }
    const connect = () => {
      if (!active() || socket) return Promise.resolve()
      if (connecting) return connecting
      const epoch = this.networkEpoch
      const pending = (async () => {
        await this.authenticate()
        if (!active() || epoch !== this.networkEpoch) return
        const url = this.endpoint('/api/control/events')
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.searchParams.set('clientId', this.clientId)
        url.searchParams.set('subscription', JSON.stringify({ ...input, after }))
        const current = (this.options.createSocket ?? ((address) => new WebSocket(address)))(url.href)
        socket = current
        const isCurrent = () => active() && socket === current && epoch === this.networkEpoch
        current.addEventListener('open', () => {
          if (isCurrent()) connection('connected')
        })
        current.addEventListener('message', (message) => {
          if (!isCurrent()) return
          try {
            const event = JSON.parse(String(message.data)) as HostControlEvent
            this.acceptHost(event.hostId)
            if (
              event.stream !== 'live' &&
              event.type !== 'resync' &&
              after?.journalEpoch === event.journalEpoch &&
              event.seq <= after.seq
            )
              return
            if (event.stream !== 'live') after = { journalEpoch: event.journalEpoch, seq: event.seq }
            listener(event)
          } catch (cause) {
            this.reportError(`无法读取 Host 控制事件：${String(cause)}`)
          }
        })
        current.addEventListener('close', () => {
          if (!isCurrent()) return
          socket = undefined
          connection('disconnected')
          const renewed = () => {
            if (epoch === this.networkEpoch) schedule(connect)
          }
          void this.renewAuthentication().then(renewed, renewed)
        })
      })().finally(() => {
        if (connecting === pending) connecting = undefined
      })
      connecting = pending
      return pending
    }
    const subscription = {
      suspend: () => {
        clearTimeout(timer)
        timer = undefined
        connecting = undefined
        const current = socket
        socket = undefined
        current?.close()
      },
      resume: async () => {
        try {
          await connect()
        } catch {
          connection('disconnected')
          schedule(connect)
        }
      },
      close: () => {
        stopped = true
        subscription.suspend()
        this.controlSubscriptions.delete(subscription)
      },
    }
    this.controlSubscriptions.add(subscription)
    const epoch = this.networkEpoch
    try {
      await connect()
    } catch (cause) {
      if (!this.suspended && epoch === this.networkEpoch) {
        subscription.close()
        throw cause
      }
    }
    return subscription.close
  }

  private acceptHost(hostId: string) {
    if (!hostId || (this.hostId && hostId !== this.hostId)) throw new Error('连接的 Host 身份已变化，请重新连接')
    this.connectedHostId = hostId
  }

  private async snapshot(
    sessionId = this.selected?.sessionKey,
    updateSelection = true,
    window?: import('@pi-meme/contracts/sessions').SessionWindow,
    scopedRecovery = false,
  ) {
    const epoch = this.selectionEpoch
    const networkEpoch = this.networkEpoch
    const args = window ? [window] : []
    let snapshot = await this.rpc<Snapshot>('pi:snapshot', args, sessionId)
    this.assertAvailable(networkEpoch)
    if (await this.recoverQueueEdits(snapshot, scopedRecovery))
      snapshot = await this.rpc<Snapshot>('pi:snapshot', args, sessionId)
    this.assertAvailable(networkEpoch)
    this.registerAgents(snapshot.agents ?? [])
    if (updateSelection && epoch === this.selectionEpoch && sessionId === this.selected?.sessionKey)
      this.selected = snapshot.connection
    if (snapshot.agent && snapshot.connection.sessionKey)
      this.executionGenerations.set(
        snapshot.connection.sessionKey,
        Math.max(
          this.executionGenerations.get(snapshot.connection.sessionKey) ?? 0,
          snapshot.agent.executionGeneration,
        ),
      )
    if (snapshot.connection.sessionKey && snapshot.eventSequence !== undefined)
      this.sequences.set(
        snapshot.connection.sessionKey,
        Math.max(this.sequences.get(snapshot.connection.sessionKey) ?? 0, snapshot.eventSequence),
      )
    return snapshot
  }

  private recoverQueueEdits(snapshot: Snapshot, scoped: boolean) {
    const key = snapshot.connection.sessionKey
    const scope = scoped && key ? `session:${key}` : 'selected'
    if (this.queueRecoveryComplete.has(scope)) return Promise.resolve(false)
    const existing = this.initialQueueRecovery.get(scope)
    if (existing) return existing
    const pending = (async () => {
      if (!key) {
        this.queueRecoveryComplete.add(scope)
        return false
      }
      const ids = new Set(
        snapshot.events?.flatMap(({ event }) =>
          event.type === 'queue_update'
            ? [...event.steering, ...event.followUp].filter((input) => input.editing).map((input) => input.id)
            : [],
        ) ?? [],
      )
      const results = await Promise.allSettled([...ids].map((id) => this.rpc('pi:cancel-queue-edit', [key, id], key)))
      for (const result of results) {
        if (result.status !== 'rejected') continue
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
        if (!message.includes('此客户端未持有排队输入编辑权') && !message.includes('排队输入不存在或已发送'))
          throw result.reason
      }
      this.queueRecoveryComplete.add(scope)
      return results.some((result) => result.status === 'fulfilled')
    })().finally(() => {
      this.initialQueueRecovery.delete(scope)
    })
    this.initialQueueRecovery.set(scope, pending)
    return pending
  }

  private registerAgents(agents: AgentSummary[]) {
    for (const agent of agents) if (agent.parentAgentId) this.childAgents.set(agent.sessionKey, agent.agentId)
    return agents
  }

  private agentSnapshot(agentId: string) {
    const pending = this.childReads.get(agentId)
    if (pending) return pending
    const networkEpoch = this.networkEpoch
    const read = this.rpc<Snapshot>('pi:agent-snapshot', [agentId], null)
      .then((snapshot) => {
        this.assertAvailable(networkEpoch)
        const key = snapshot.connection.sessionKey
        if (
          key &&
          !(snapshot.agent && snapshot.agent.executionGeneration < (this.executionGenerations.get(key) ?? 0))
        ) {
          this.childAgents.set(key, agentId)
          this.sequences.set(key, snapshot.eventSequence ?? 0)
          if (snapshot.agent) this.executionGenerations.set(key, snapshot.agent.executionGeneration)
        }
        return snapshot
      })
      .finally(() => this.childReads.delete(agentId))
    this.childReads.set(agentId, read)
    return read
  }

  private async selection(method: string, args: unknown[] = [], sessionId = this.selected?.sessionKey) {
    const epoch = ++this.selectionEpoch
    this.pendingSelections++
    let accepted: Connection | undefined
    try {
      const result = await this.rpc<Awaited<ReturnType<DesktopBridge['switchSession']>>>(method, args, sessionId)
      if (!result.cancelled && epoch === this.selectionEpoch) {
        this.selected = result.snapshot.connection
        accepted = result.snapshot.connection
      }
      return result
    } finally {
      this.pendingSelections--
      if (accepted && epoch === this.selectionEpoch) this.publishConnection(accepted)
    }
  }

  private async deletion(method: string, args: unknown[]) {
    let epoch = this.selectionEpoch
    this.pendingSelections++
    let accepted: Connection | undefined
    try {
      const result = await this.rpc<WorkspaceDeletionResult>(method, args)
      if (result.selection && !result.selection.cancelled && epoch === this.selectionEpoch) {
        epoch = ++this.selectionEpoch
        this.selected = result.selection.snapshot.connection
        accepted = this.selected
      }
      return result
    } finally {
      this.pendingSelections--
      if (accepted && epoch === this.selectionEpoch) this.publishConnection(accepted)
    }
  }

  private openSocket() {
    if (this.closed || this.suspended || this.socket) return
    const epoch = this.networkEpoch
    const url = this.endpoint('/api/events')
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('clientId', this.clientId)
    const socket = (this.options.createSocket ?? ((address) => new WebSocket(address)))(url.href)
    this.socket = socket
    const isCurrent = () => !this.closed && !this.suspended && this.socket === socket && epoch === this.networkEpoch
    socket.addEventListener('open', () => {
      if (isCurrent()) void this.resynchronize()
    })
    socket.addEventListener('message', (message) => {
      if (!isCurrent()) return
      try {
        const envelope = JSON.parse(String(message.data)) as HostEvent
        this.acceptHost(envelope.hostId)
        if (this.resynchronizing) this.buffered.push(envelope)
        else this.receive(envelope)
      } catch (cause) {
        this.reportError(`无法读取 Host 事件：${String(cause)}`)
      }
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      if (this.closed || this.suspended || epoch !== this.networkEpoch) return
      if (this.selected)
        this.publishConnection({ ...this.selected, status: 'disconnected', error: 'Host 连接已断开，正在重连' })
      const delay = Math.min((this.options.reconnectDelay ?? 1000) * 2 ** this.reconnectAttempts++, 15000)
      this.reconnectTimer = setTimeout(() => void this.reconnectSocket(), delay)
    })
    socket.addEventListener('error', () => {
      if (isCurrent()) this.reportError('WebSocket 连接失败，请检查 Host 地址和网络')
    })
  }

  private async reconnectSocket() {
    if (this.closed || this.suspended) return
    const epoch = this.networkEpoch
    try {
      await this.renewAuthentication()
      if (!this.closed && !this.suspended && epoch === this.networkEpoch) this.openSocket()
    } catch (cause) {
      if (this.closed || this.suspended || epoch !== this.networkEpoch) return
      this.reportError(`Host 重新认证失败：${String(cause)}`)
      const delay = Math.min((this.options.reconnectDelay ?? 1000) * 2 ** this.reconnectAttempts++, 15000)
      this.reconnectTimer = setTimeout(() => void this.reconnectSocket(), delay)
    }
  }

  private resynchronize(sessionId = this.selected?.sessionKey) {
    if (this.resynchronizing) return this.resynchronizing
    const networkEpoch = this.networkEpoch
    let recovered = false
    const pending = (async () => {
      try {
        const epoch = this.selectionEpoch
        const scoped = Boolean(sessionId && this.scopedConnectionListeners.has(sessionId))
        const snapshot = await this.snapshot(sessionId, sessionId === this.selected?.sessionKey, undefined, scoped)
        this.assertAvailable(networkEpoch)
        if (epoch === this.selectionEpoch && snapshot.connection.sessionKey === this.selected?.sessionKey)
          this.publishConnection(snapshot.connection)
        else if (snapshot.connection.sessionKey) {
          const listeners = this.scopedConnectionListeners.get(snapshot.connection.sessionKey)
          for (const callback of listeners ?? []) {
            callback({ ...snapshot.connection, status: 'connecting' })
            callback(snapshot.connection)
          }
        }
        await Promise.allSettled([...new Set(this.childAgents.values())].map((id) => this.agentSnapshot(id)))
        this.assertAvailable(networkEpoch)
        for (const callback of this.sessionsListeners) callback()
        for (const callback of this.pluginListeners) callback()
        this.reconnectAttempts = 0
        recovered = true
      } catch (cause) {
        if (!this.closed && !this.suspended && networkEpoch === this.networkEpoch) {
          this.reportError(`无法恢复 Host 快照：${String(cause)}`)
          this.socket?.close()
        }
      }
    })().finally(() => {
      if (this.resynchronizing === pending) this.resynchronizing = undefined
      if (networkEpoch === this.networkEpoch) {
        const buffered = this.buffered
        this.buffered = []
        if (recovered) for (const envelope of buffered) this.receive(envelope)
      }
    })
    this.resynchronizing = pending
    return pending
  }

  private publishConnection(connection: Connection) {
    this.selected = connection
    for (const callback of this.connectionListeners) callback(connection)
  }

  private receive(envelope: HostEvent) {
    switch (envelope.type) {
      case 'event': {
        const record = envelope.value
        if (record.event.type === 'agents_update') this.registerAgents(record.event.agents)
        if (
          record.sessionKey &&
          record.agentId &&
          record.agentId !== record.rootAgentId &&
          record.sessionKey !== this.selected?.sessionKey
        )
          this.childAgents.set(record.sessionKey, record.agentId)
        if (record.sessionKey && record.executionGeneration !== undefined) {
          const childId = this.childAgents.get(record.sessionKey)
          const execution = this.executionGenerations.get(record.sessionKey)
          if (
            record.executionGeneration !== undefined &&
            execution !== undefined &&
            record.executionGeneration < execution
          )
            return
          if (record.executionGeneration !== execution) {
            this.executionGenerations.set(record.sessionKey, record.executionGeneration)
            this.sequences.delete(record.sessionKey)
            if (childId) void this.agentSnapshot(childId).catch((cause) => this.reportError(String(cause)))
          }
        }
        if (record.sessionKey && record.sequence !== undefined) {
          const childId = this.childAgents.get(record.sessionKey)
          const previous = this.sequences.get(record.sessionKey) ?? (childId ? 0 : undefined)
          if (previous !== undefined && record.sequence <= previous) return
          if (previous !== undefined && record.sequence > previous + 1) {
            if (childId) {
              for (const callback of this.eventListeners) callback(record)
              void this.agentSnapshot(childId).catch((cause) =>
                this.reportError(`无法恢复子代理快照：${String(cause)}`),
              )
            } else {
              this.buffered.push(envelope)
              void this.resynchronize(record.sessionKey)
            }
            return
          }
          this.sequences.set(record.sessionKey, record.sequence)
        }
        for (const callback of this.eventListeners) callback(record)
        break
      }
      case 'connection': {
        const connection = envelope.value
        if (connection.sessionKey)
          for (const callback of this.scopedConnectionListeners.get(connection.sessionKey) ?? []) callback(connection)
        if (!this.pendingSelections && (!this.selected || connection.sessionKey === this.selected.sessionKey))
          this.publishConnection(connection)
        break
      }
      case 'error':
        for (const callback of this.errorListeners) callback(envelope.value)
        break
      case 'sessions-changed':
        for (const callback of this.sessionsListeners) callback()
        break
      case 'services-changed':
        for (const callback of this.servicesListeners) callback()
        break
      case 'resources-changed':
      case 'plugins-changed':
        for (const callback of this.pluginListeners) callback()
        break
    }
  }

  private reportError(message: string) {
    for (const callback of this.errorListeners)
      callback({ generation: this.selected?.generation ?? 0, sessionKey: this.selected?.sessionKey, message })
  }

  close() {
    this.suspend()
    this.closed = true
    for (const subscription of [...this.controlSubscriptions]) subscription.close()
    clearTimeout(this.reconnectTimer)
    this.socket?.close()
    this.socket = undefined
    this.buffered = []
    this.eventListeners.clear()
    this.connectionListeners.clear()
    this.scopedConnectionListeners.clear()
    this.errorListeners.clear()
    this.sessionsListeners.clear()
    this.servicesListeners.clear()
    this.pluginListeners.clear()
  }

  private async directory() {
    if (this.options.connection.local && this.options.platform) return this.options.platform.chooseDirectory()
    return this.options.selectDirectory((path) => this.rpc<HostDirectory>('host:directories', path ? [path] : []))
  }

  private createBridge(sessionKey?: string): DesktopBridge {
    let scopedConnection: Connection | undefined
    const readSnapshot = async (window?: import('@pi-meme/contracts/sessions').SessionWindow) => {
      const snapshot = await this.snapshot(sessionKey, !sessionKey, window, Boolean(sessionKey))
      if (!sessionKey) return snapshot
      scopedConnection = snapshot.connection
      return snapshot
    }
    const rpc = <T>(
      method: string,
      args: unknown[] = [],
      sessionId: string | null | undefined = sessionKey ?? this.selected?.sessionKey,
    ) => this.rpc<T>(method, args, sessionId)
    const subscribe = <T>(listeners: Set<(value: T) => void>, callback: (value: T) => void) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    }
    const platform = this.options.connection.local ? this.options.platform : undefined
    const openPath = async (field: 'themesDirectory') => {
      const settings = await rpc<SettingsSnapshot>('settings:get')
      if (!platform) throw new Error(`目录位于 Host：${settings[field]}`)
      await platform.openPath(settings[field])
    }
    const settingsRpc = async (method: string, args: unknown[] = []) => {
      const snapshot = await rpc<SettingsSnapshot>(method, args)
      return {
        ...snapshot,
        themes: snapshot.themes.map((theme) => ({
          ...theme,
          ...(theme.background?.url
            ? { background: { ...theme.background, url: this.resourceUrl(theme.background.url) } }
            : {}),
        })),
      }
    }
    return {
      scopeSession: (key) => this.createBridge(key),
      openTemporarySession: (key) => rpc('temporary-session:open', [{ sourceSessionKey: key }], key),
      getTemporarySession: () => rpc('temporary-session:get', [], null),
      closeTemporarySession: async (key) => {
        const result = await rpc<{ closed: boolean }>('temporary-session:close', [key], key)
        if (result.closed) this.queueRecoveryComplete.delete(`session:${key}`)
        return result
      },
      getConnection: async () => (await readSnapshot({ limit: 60 })).connection,
      startGoal: (key, input) => rpc('goal:start', [key, input], key),
      editGoal: (key, input) => rpc('goal:edit', [key, input], key),
      pauseGoal: (key, input) => rpc('goal:pause', [key, input], key),
      resumeGoal: (key, input) => rpc('goal:resume', [key, input], key),
      clearGoal: (key, input) => rpc('goal:clear', [key, input], key),
      resolveAppSession: (sessionKey) => rpc('host:session-ref', [sessionKey], sessionKey),
      getSnapshot: readSnapshot,
      onConnection: (callback) => {
        if (!sessionKey) return subscribe(this.connectionListeners, callback)
        let active = true
        let disconnected = false
        const scopedListeners = this.scopedConnectionListeners.get(sessionKey) ?? new Set<(value: Connection) => void>()
        this.scopedConnectionListeners.set(sessionKey, scopedListeners)
        const offScoped = subscribe(scopedListeners, (connection) => {
          scopedConnection = connection
          callback(connection)
        })
        const off = subscribe(this.connectionListeners, (connection) => {
          if (!active || !scopedConnection) return
          if (connection.status === 'disconnected') {
            disconnected = true
            scopedConnection = { ...scopedConnection, status: 'disconnected', error: connection.error }
            callback(scopedConnection)
          } else if (disconnected && (connection.status === 'idle' || connection.status === 'ready')) {
            disconnected = false
            void readSnapshot({ limit: 60 }).then(
              (snapshot) => {
                if (active) callback(snapshot.connection)
              },
              (cause: unknown) => {
                if (active && scopedConnection)
                  callback({ ...scopedConnection, status: 'disconnected', error: String(cause) })
              },
            )
          }
        })
        return () => {
          active = false
          off()
          offScoped()
          if (!scopedListeners.size) this.scopedConnectionListeners.delete(sessionKey)
        }
      },
      onEvent: (callback) => subscribe(this.eventListeners, callback),
      onError: (callback) => subscribe(this.errorListeners, callback),
      onSessionsChanged: (callback) => subscribe(this.sessionsListeners, callback),
      pickProjectDirectory: () => this.directory(),
      addProjectDirectory: async () => {
        const path = await this.directory()
        return path ? rpc('project:register', [path]) : null
      },
      chooseDirectory: async (targetPath) => {
        const path = targetPath ?? (await this.directory())
        if (!path) return null
        await this.selection('pi:directory', [path])
        return path
      },
      getProjectApps: () => platform?.getProjectApps() ?? Promise.resolve([]),
      openProject: async (app, cwd) => {
        if (!platform) throw new Error('浏览器和远程 Host 无法打开本机 Finder 或编辑器')
        await platform.openProject(app, cwd ?? this.selected?.cwd ?? '')
      },
      setPreferredProjectApp: (app) => rpc('project:preferred-app', [app]),
      getProjects: () => rpc('workspace:projects'),
      renameProject: (cwd, name) => rpc('project:rename', [cwd, name]),
      previewProjectDeletion: (cwd) => rpc('project:delete-preview', [cwd]),
      removeProject: (cwd, paths) => this.deletion('project:remove', [cwd, paths]),
      renameSession: (path, name) => rpc('session:rename', [path, name]),
      deleteSession: (path) => this.deletion('session:delete', [path]),
      selectWorkspace: (input) => this.selection('workspace:select', [input]),
      getSessions: () => rpc('pi:sessions'),
      newSession: () => this.selection('pi:new-session'),
      switchSession: (path, window) => this.selection('pi:switch-session', window ? [path, window] : [path]),
      readSessionHistory: (path, window) => rpc('session:history', window ? [path, window] : [path]),
      searchSessions: (query, paths) => rpc('session:search', [query, paths], null),
      prefetchSession: (path) => rpc('session:prefetch', [path]),
      togglePin: (path) => rpc('settings:toggle-pin', [path]),
      uploadAttachment: (key, input, signal, onProgress) => this.uploadAttachment(key, input, signal, onProgress),
      prompt: (key, message, images, skills, options) =>
        rpc('pi:prompt', [key, message, images ?? [], skills ?? [], ...(options === undefined ? [] : [options])], key),
      steer: (key, message, images, skills, options) =>
        rpc('pi:steer', [key, message, images ?? [], skills ?? [], ...(options === undefined ? [] : [options])], key),
      followUp: (key, message, images, skills, options) =>
        rpc(
          'pi:follow-up',
          [key, message, images ?? [], skills ?? [], ...(options === undefined ? [] : [options])],
          key,
        ),
      getAgents: async (key) => this.registerAgents(await rpc<AgentSummary[]>('pi:agents', [key], key)),
      getAgentSnapshot: (id) => this.agentSnapshot(id),
      interruptAgent: (id) => this.rpc('pi:interrupt-agent', [id], null),
      setSessionMode: (key, mode) => rpc('pi:session-mode', [key, mode], key),
      pause: (key) => rpc('pi:pause', [key], key),
      resume: (key) => rpc('pi:resume', [key], key),
      stopTask: (key) => rpc('pi:stop-task', [key], key),
      continueStopped: (key, configuration) => rpc('pi:continue-stopped', [key, configuration], key),
      recover: (key, failureEntryId) => rpc('pi:recover', [key, failureEntryId], key),
      steerQueueInput: (key, id) => rpc('pi:steer-queue-input', [key, id], key),
      deleteQueueInput: (key, id) => rpc('pi:delete-queue-input', [key, id], key),
      beginQueueEdit: (key, id) => rpc('pi:begin-queue-edit', [key, id], key),
      updateQueueInput: (key, id, message, images, skills, options) =>
        rpc('pi:update-queue-input', [key, id, message, images ?? [], skills ?? [], options], key),
      cancelQueueEdit: (key, id) => rpc('pi:cancel-queue-edit', [key, id], key),
      clearQueue: (key) => rpc('pi:clear-queue', [key], key),
      setSteeringMode: (key, mode) => rpc('pi:steering-mode', [key, mode], key),
      setFollowUpMode: (key, mode) => rpc('pi:follow-up-mode', [key, mode], key),
      setAccessMode: (key, mode) => rpc('pi:access-mode', [key, mode], key),
      getProjectFiles: (cwd, query) => rpc('chat:project-files', [cwd, query]),
      getCommands: () => rpc('pi:commands'),
      abort: (key) => rpc('pi:abort', [key], key),
      editAndPrompt: (key, entryId, message, images, skills, options) =>
        rpc(
          'pi:edit-and-prompt',
          [key, entryId, message, images ?? [], skills ?? [], ...(options === undefined ? [] : [options])],
          key,
        ),
      forkReply: (key, timestamp) => this.selection('pi:fork-reply', [key, timestamp], key),
      respondExtensionUI: (key, id, response) => rpc('pi:extension-ui-response', [key, id, response], key),
      getGitEnvironment: (key) => rpc('git:environment', [key], key),
      switchGitBranch: (key, branch) => this.selection('git:switch-branch', [key, branch], key),
      createGitBranch: (key, branch, baseRef) => this.selection('git:create-branch', [key, branch, baseRef], key),
      createGitWorktree: async (key, baseRef) => {
        const epoch = ++this.selectionEpoch
        this.pendingSelections++
        try {
          const result = await rpc<Awaited<ReturnType<DesktopBridge['createGitWorktree']>>>(
            'git:create-worktree',
            [key, baseRef],
            key,
          )
          if (result.selection && !result.selection.cancelled && epoch === this.selectionEpoch) {
            this.selected = result.selection.snapshot.connection
            this.publishConnection(this.selected)
          } else if (result.selection && epoch !== this.selectionEpoch)
            return { ...result, selection: { cancelled: true } }
          return result
        } finally {
          this.pendingSelections--
        }
      },
      getGitSnapshot: () => rpc('git:snapshot'),
      getGitDiff: (path, kind) => rpc('git:diff', [path, kind]),
      setModel: (key, model) => rpc('pi:set-model', [key, model], key),
      setThinkingLevel: (key, level) => rpc('pi:set-thinking-level', [key, level], key),
      getAvailableThinkingLevels: () => rpc('pi:thinking-levels'),
      getSessionStats: () => rpc('pi:session-stats'),
      getModelConfig: () => rpc('models:get'),
      getDefaultModel: () => rpc('models:default'),
      setDefaultModel: (model) => rpc('models:set-default', [model]),
      getDefaultThinkingLevel: () => rpc('models:default-thinking'),
      setDefaultThinkingLevel: (level) => rpc('models:set-default-thinking', [level]),
      saveModelProvider: (input) => rpc('models:save', [input]),
      deleteModelProvider: (id, revision) => rpc('models:delete', [id, revision]),
      discoverModels: (input) => rpc('models:discover', [input]),
      reconnectModels: () => rpc('models:reconnect'),
      listBuiltinProviders: () => rpc('models:builtins', [], null),
      startBuiltinLogin: (input) => rpc('models:builtin-login', [input], null),
      getBuiltinLogin: () => rpc('models:builtin-login-state', [], null),
      respondBuiltinLogin: (input) => rpc('models:builtin-login-respond', [input], null),
      cancelBuiltinLogin: () => rpc('models:builtin-login-cancel', [], null),
      logoutBuiltinProvider: (providerId) => rpc('models:builtin-logout', [providerId], null),
      getStorageInfo: () => rpc('host:storage-info', [], null),
      storage: platform?.storage,
      getUsageStats: () => rpc('settings:usage-stats'),
      getSettings: () => settingsRpc('settings:get'),
      getInstructions: () => rpc('settings:instructions'),
      saveInstruction: (input) => rpc('settings:save-instruction', [input]),
      getSubagents: () => rpc('settings:subagents'),
      reloadSubagents: () => rpc('settings:reload-subagents'),
      saveSettings: (settings) => settingsRpc('settings:save', [settings]),
      saveSubagentDefaults: (patch) => rpc('settings:subagent-defaults', [patch], null),
      saveEditorSettings: (settings) => rpc('settings:editor', [settings], null),
      saveSidebarPreferences: (patch) => rpc('settings:sidebar', [patch]),
      saveAppearance: (appearance) => settingsRpc('settings:appearance', [appearance]),
      getInstalledFonts: () => rpc('settings:fonts'),
      importTheme: async () => {
        const content = platform ? await platform.importTheme() : await readThemeFile()
        return content === null ? null : settingsRpc('settings:import-theme-content', [content])
      },
      exportTheme: async (theme) => {
        const content = await rpc<Theme>('settings:export-theme-content', [theme])
        if (platform) await platform.exportTheme(content)
        else downloadTheme(content)
      },
      selectTheme: (id) => settingsRpc('settings:theme', [id]),
      reloadThemes: () => settingsRpc('settings:reload-themes'),
      openThemesDirectory: () => openPath('themesDirectory'),
      getUserProfile: () => rpc('settings:get-user-profile'),
      saveUserProfile: (profile) => rpc('settings:save-user-profile', [profile]),
      getMcpConfig: () => rpc('mcp:get'),
      saveMcpServer: (input) => rpc('mcp:save', [input]),
      deleteMcpServer: (input) => rpc('mcp:delete', [input]),
      checkMcpServers: (key) => rpc('mcp:check', [key], key),
    }
  }
}

function readThemeFile(): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.addEventListener(
      'change',
      () => {
        const file = input.files?.[0]
        if (!file) {
          resolve(null)
          return
        }
        void file
          .text()
          .then((text) => resolve(JSON.parse(text) as unknown))
          .catch(() => reject(new Error('主题文件不是有效的 JSON')))
      },
      { once: true },
    )
    input.click()
  })
}

function downloadTheme(theme: Theme) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${theme.id.replace(/[^\w-]/g, '_')}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
