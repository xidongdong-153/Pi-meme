import type {
  HostApi,
  HostControlResponse,
  EventSubscription,
  EventCursor,
  HostControlEvent,
} from '@pi-meme/contracts/app-host'
import { createAppHostClient } from './app-host-client'
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

export class HostClient {
  readonly clientId: string
  readonly host: HostApi
  private readonly controlClosers = new Set<() => void>()
  readonly bridge: DesktopBridge
  readonly plugins: PluginClient
  readonly resources: ResourceClient
  private readonly url: URL
  private readonly fetch: typeof fetch
  private readonly eventListeners = new Set<(value: DesktopEvent) => void>()
  private readonly connectionListeners = new Set<(value: Connection) => void>()
  private readonly errorListeners = new Set<(value: DesktopError) => void>()
  private readonly sessionsListeners = new Set<() => void>()
  private readonly pluginListeners = new Set<() => void>()
  private socket?: WebSocket
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectAttempts = 0
  private closed = false
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
  private queueRecoveryComplete = false
  private initialQueueRecovery?: Promise<boolean>

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

  async connect() {
    if (this.closed) throw new Error('Host 客户端已关闭')
    await this.authenticate()
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
    if (this.options.endpoint?.authenticate === false) return Promise.resolve()
    this.authenticated ??= (async () => {
      const response = await this.fetch(this.endpoint('/api/auth'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: this.options.connection.token }),
      })
      if (!response.ok) throw new Error('Host 认证失败，请检查访问令牌')
      this.options.connection.token = ''
    })().catch((error: unknown) => {
      this.authenticated = undefined
      throw error
    })
    return this.authenticated
  }

  reauthenticate() {
    return this.renewAuthentication()
  }

  private renewAuthentication() {
    this.renewing ??= (async () => {
      this.authenticated = undefined
      if (this.options.endpoint?.renewAuthentication) await this.options.endpoint.renewAuthentication()
      else if (this.options.platform) {
        const connection = await this.options.platform.getHostConnection()
        if (
          new URL(connection.url).origin !== this.url.origin ||
          (this.hostId && connection.hostId && this.hostId !== connection.hostId)
        )
          throw new Error('Host 连接已变化，请重新连接')
        this.options.connection.token = connection.token
      }
      await this.authenticate()
    })().finally(() => {
      this.renewing = undefined
    })
    return this.renewing
  }

  async rpc<T>(
    method: string,
    args: unknown[] = [],
    sessionId: string | null | undefined = this.selected?.sessionKey,
  ): Promise<T> {
    if (this.closed) throw new Error('Host 客户端已关闭')
    await this.authenticate()
    const requestId = crypto.randomUUID()
    const send = async () => {
      try {
        return await this.fetch(this.endpoint('/api/rpc'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
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
        throw new Error(`无法连接 Host，操作没有自动重发：${String(cause)}`)
      }
    }
    let response = await send()
    if (response.status === 401) {
      await this.renewAuthentication()
      if (this.closed) throw new Error('Host 客户端已关闭')
      response = await send()
    }
    if (response.status === 401) throw new Error('Host 登录已失效，请重新连接')
    const value: unknown = await response.json()
    if (!value || typeof value !== 'object' || !('requestId' in value)) {
      const error = value && typeof value === 'object' && 'error' in value ? value.error : undefined
      throw new Error(typeof error === 'string' ? error : `Host 请求失败：HTTP ${response.status}`)
    }
    const envelope = value as HostRpcResponse
    if (envelope.requestId !== requestId) throw new Error('Host 返回了不匹配的请求标识')
    this.acceptHost(envelope.hostId)
    if (envelope.error) throw new Error(envelope.error.message)
    if (!response.ok) throw new Error(`Host 请求失败：HTTP ${response.status}`)
    return envelope.result as T
  }

  private async controlCall<T>(method: string, args: unknown[], idempotencyKey?: string): Promise<T> {
    if (this.closed) throw new Error('Host 客户端已关闭')
    await this.authenticate()
    const body = JSON.stringify({
      apiVersion: 2,
      hostId: this.connectedHostId,
      clientId: this.clientId,
      method,
      args,
      idempotencyKey,
    })
    const send = () =>
      this.fetch(this.endpoint('/api/control'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
    let response = await send()
    if (response.status === 401) {
      await this.renewAuthentication()
      response = await send()
    }
    if (!response.ok) throw new Error(`Host 请求失败：HTTP ${response.status}`)
    const value = (await response.json()) as HostControlResponse
    this.acceptHost(value.hostId)
    if (value.error) throw Object.assign(new Error(value.error.message), { code: value.error.code })
    return value.result as T
  }

  private async subscribeControl(input: EventSubscription, listener: (event: HostControlEvent) => void) {
    let stopped = false
    let after: EventCursor | undefined = input.after
    let socket: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (!stopped && !this.closed)
        timer = setTimeout(() => {
          void connect(this).catch(schedule)
        }, this.options.reconnectDelay ?? 1000)
    }
    async function connect(client: HostClient) {
      if (stopped || client.closed) return
      await client.authenticate()
      if (stopped || client.closed) return
      const url = client.endpoint('/api/control/events')
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('clientId', client.clientId)
      url.searchParams.set('subscription', JSON.stringify({ ...input, after }))
      socket = (client.options.createSocket ?? ((address) => new WebSocket(address)))(url.href)
      socket.addEventListener('message', (message) => {
        const event = JSON.parse(String(message.data)) as HostControlEvent
        client.acceptHost(event.hostId)
        if (
          event.stream !== 'live' &&
          event.type !== 'resync' &&
          after?.journalEpoch === event.journalEpoch &&
          event.seq <= after.seq
        )
          return
        if (event.stream !== 'live') after = { journalEpoch: event.journalEpoch, seq: event.seq }
        listener(event)
      })
      socket.addEventListener('close', () => {
        if (!stopped && !client.closed) void client.renewAuthentication().then(schedule, schedule)
      })
    }
    await connect(this)
    const close = () => {
      stopped = true
      if (timer) clearTimeout(timer)
      socket?.close()
      this.controlClosers.delete(close)
    }
    this.controlClosers.add(close)
    return close
  }

  private acceptHost(hostId: string) {
    if (!hostId || (this.hostId && hostId !== this.hostId)) throw new Error('连接的 Host 身份已变化，请重新连接')
    this.connectedHostId = hostId
  }

  private async snapshot(sessionId = this.selected?.sessionKey, updateSelection = true) {
    const epoch = this.selectionEpoch
    let snapshot = await this.rpc<Snapshot>('pi:snapshot', [], sessionId)
    if (await this.recoverQueueEdits(snapshot)) snapshot = await this.rpc<Snapshot>('pi:snapshot', [], sessionId)
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

  private recoverQueueEdits(snapshot: Snapshot) {
    if (this.queueRecoveryComplete) return Promise.resolve(false)
    this.initialQueueRecovery ??= (async () => {
      const key = snapshot.connection.sessionKey
      if (!key) {
        this.queueRecoveryComplete = true
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
      this.queueRecoveryComplete = true
      return results.some((result) => result.status === 'fulfilled')
    })().catch((cause: unknown) => {
      this.initialQueueRecovery = undefined
      throw cause
    })
    return this.initialQueueRecovery
  }

  private registerAgents(agents: AgentSummary[]) {
    for (const agent of agents) if (agent.parentAgentId) this.childAgents.set(agent.sessionKey, agent.agentId)
    return agents
  }

  private agentSnapshot(agentId: string) {
    const pending = this.childReads.get(agentId)
    if (pending) return pending
    const read = this.rpc<Snapshot>('pi:agent-snapshot', [agentId], null)
      .then((snapshot) => {
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
    if (this.closed || this.socket) return
    const url = this.endpoint('/api/events')
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('clientId', this.clientId)
    const socket = (this.options.createSocket ?? ((address) => new WebSocket(address)))(url.href)
    this.socket = socket
    socket.addEventListener('open', () => {
      void this.resynchronize()
    })
    socket.addEventListener('message', (message) => {
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
      if (this.closed) return
      if (this.selected)
        this.publishConnection({ ...this.selected, status: 'disconnected', error: 'Host 连接已断开，正在重连' })
      const delay = Math.min((this.options.reconnectDelay ?? 1000) * 2 ** this.reconnectAttempts++, 15000)
      this.reconnectTimer = setTimeout(() => void this.reconnectSocket(), delay)
    })
    socket.addEventListener('error', () => this.reportError('WebSocket 连接失败，请检查 Host 地址和网络'))
  }

  private async reconnectSocket() {
    try {
      await this.renewAuthentication()
      if (!this.closed) this.openSocket()
    } catch (cause) {
      if (this.closed) return
      this.reportError(`Host 重新认证失败：${String(cause)}`)
      const delay = Math.min((this.options.reconnectDelay ?? 1000) * 2 ** this.reconnectAttempts++, 15000)
      this.reconnectTimer = setTimeout(() => void this.reconnectSocket(), delay)
    }
  }

  private resynchronize(sessionId = this.selected?.sessionKey) {
    if (this.resynchronizing) return this.resynchronizing
    this.resynchronizing = (async () => {
      let recovered = false
      try {
        const epoch = this.selectionEpoch
        const snapshot = await this.snapshot(sessionId, sessionId === this.selected?.sessionKey)
        if (epoch === this.selectionEpoch && snapshot.connection.sessionKey === this.selected?.sessionKey)
          this.publishConnection(snapshot.connection)
        await Promise.allSettled([...new Set(this.childAgents.values())].map((id) => this.agentSnapshot(id)))
        for (const callback of this.sessionsListeners) callback()
        for (const callback of this.pluginListeners) callback()
        this.reconnectAttempts = 0
        recovered = true
      } catch (cause) {
        this.reportError(`无法恢复 Host 快照：${String(cause)}`)
        this.socket?.close()
      } finally {
        this.resynchronizing = undefined
        const pending = this.buffered
        this.buffered = []
        if (recovered) for (const envelope of pending) this.receive(envelope)
      }
    })()
    return this.resynchronizing
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
      case 'connection':
        if (!this.pendingSelections && (!this.selected || envelope.value.sessionKey === this.selected.sessionKey))
          this.publishConnection(envelope.value)
        break
      case 'error':
        for (const callback of this.errorListeners) callback(envelope.value)
        break
      case 'sessions-changed':
        for (const callback of this.sessionsListeners) callback()
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
    this.closed = true
    for (const close of [...this.controlClosers]) close()
    clearTimeout(this.reconnectTimer)
    this.socket?.close()
    this.socket = undefined
    this.buffered = []
    this.eventListeners.clear()
    this.connectionListeners.clear()
    this.errorListeners.clear()
    this.sessionsListeners.clear()
    this.pluginListeners.clear()
  }

  private async directory() {
    if (this.options.connection.local && this.options.platform) return this.options.platform.chooseDirectory()
    return this.options.selectDirectory((path) => this.rpc<HostDirectory>('host:directories', path ? [path] : []))
  }

  private createBridge(): DesktopBridge {
    const rpc = <T>(method: string, args: unknown[] = [], sessionId = this.selected?.sessionKey) =>
      this.rpc<T>(method, args, sessionId)
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
      getConnection: async () => (await this.snapshot()).connection,
      resolveAppSession: (sessionKey) => rpc('host:session-ref', [sessionKey], sessionKey),
      getSnapshot: () => this.snapshot(),
      onConnection: (callback) => subscribe(this.connectionListeners, callback),
      onEvent: (callback) => subscribe(this.eventListeners, callback),
      onError: (callback) => subscribe(this.errorListeners, callback),
      onSessionsChanged: (callback) => subscribe(this.sessionsListeners, callback),
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
      switchSession: (path) => this.selection('pi:switch-session', [path]),
      readSessionHistory: (path) => rpc('session:history', [path]),
      prefetchSession: (path) => rpc('session:prefetch', [path]),
      togglePin: (path) => rpc('settings:toggle-pin', [path]),
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
      editAndPrompt: (key, timestamp, message, images, skills, options) =>
        rpc(
          'pi:edit-and-prompt',
          [key, timestamp, message, images ?? [], skills ?? [], ...(options === undefined ? [] : [options])],
          key,
        ),
      switchMessageVersion: (key, timestamp, version) =>
        rpc('pi:switch-message-version', [key, timestamp, version], key),
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
      getUsageStats: () => rpc('settings:usage-stats'),
      getSettings: () => settingsRpc('settings:get'),
      getInstructions: () => rpc('settings:instructions'),
      saveInstruction: (input) => rpc('settings:save-instruction', [input]),
      getSubagents: () => rpc('settings:subagents'),
      reloadSubagents: () => rpc('settings:reload-subagents'),
      saveSettings: (settings) => settingsRpc('settings:save', [settings]),
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
