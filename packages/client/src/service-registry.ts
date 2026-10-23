import type { HostService, HostServiceRegistration, PlatformAdapter } from '@pi-meme/contracts/host'
import type {
  SshCandidate,
  SshCapabilities,
  SshConnection,
  SshConnectionInput,
} from '@pi-meme/contracts/ssh-connections'
import { HostClient, type ClientOptions } from './host-client'

export type ServiceRegistryOptions = {
  baseUrl: string
  platform?: PlatformAdapter
  selectDirectory: ClientOptions['selectDirectory']
  fetch?: typeof fetch
  createSocket?: ClientOptions['createSocket']
}

export class HostServiceRegistry {
  private readonly clients = new Map<string, HostClient>()
  private readonly states = new Map<string, HostService>()
  private readonly disposers = new Map<string, Array<() => void>>()
  private readonly listeners = new Set<() => void>()
  private readonly refreshes = new Map<string, symbol>()
  private serviceRefresh?: Promise<void>
  private serviceRefreshRequested = false
  private initialized = false
  private closed = false
  readonly localServiceId = 'local'
  readonly ssh = {
    capabilities: () => this.local.rpc<SshCapabilities>('host:ssh:capabilities', [], null),
    list: () => this.local.rpc<SshConnection[]>('host:ssh:list', [], null),
    discover: () => this.local.rpc<SshCandidate[]>('host:ssh:discover', [], null),
    save: (input: SshConnectionInput) => this.changeSsh<SshConnection>('save', [input]),
    setEnabled: (id: string, enabled: boolean) => this.changeSsh<SshConnection>('enabled', [id, enabled]),
    retry: (id: string) => this.changeSsh<SshConnection>('retry', [id]),
    remove: (id: string) => this.changeSsh<void>('remove', [id]),
  }

  constructor(
    readonly local: HostClient,
    private readonly options: ServiceRegistryOptions,
  ) {
    this.clients.set(this.localServiceId, local)
    this.disposers.set(this.localServiceId, [
      local.bridge.onSessionsChanged(() => {
        void this.refresh(this.localServiceId).catch(() => {})
      }),
      local.onServicesChanged(() => {
        void this.refreshServices().catch(() => {})
      }),
      local.bridge.onConnection((connection) => {
        if (connection.status !== 'disconnected') void this.refreshServices().catch(() => {})
      }),
    ])
    this.states.set(this.localServiceId, {
      id: this.localServiceId,
      hostId: local.hostId,
      address: local.hostAddress,
      local: true,
      status: 'connected',
      projects: [],
    })
  }
  list() {
    return [...this.states.values()]
  }
  get(id: string) {
    const client = this.clients.get(id)
    if (!client) throw new Error('服务客户端不存在')
    return client
  }
  subscribe(callback: () => void) {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }
  private publish() {
    for (const callback of this.listeners) callback()
  }
  private canConnect(state: HostService) {
    return state.transport !== 'ssh' || (state.enabled === true && state.phase === 'connected')
  }
  private accept(state: HostService) {
    const existing = this.states.get(state.id)
    const wasConnectable = existing ? this.canConnect(existing) : false
    const fresh = !this.clients.has(state.id)
    if (existing) {
      Object.assign(existing, state, {
        error: state.error,
        errorCode: state.errorCode,
        nextRetryAt: state.nextRetryAt,
      })
      state = existing
    }
    this.states.set(state.id, state)
    if (fresh) {
      const client = new HostClient({
        ...this.options,
        connection: { url: state.address, hostId: state.hostId, local: false, token: '' },
        endpoint: { baseUrl: this.options.baseUrl, apiPrefix: `/api/services/${state.id}`, authenticate: true },
        platform: undefined,
      })
      this.clients.set(state.id, client)
      const disposers = [
        client.bridge.onConnection((connection) => {
          if (state.transport === 'ssh') {
            if (connection.status === 'disconnected' && this.canConnect(state))
              void this.refreshServices().catch(() => {})
            return
          }
          state.status = connection.status === 'disconnected' ? 'disconnected' : 'connected'
          state.error = connection.error
          this.publish()
        }),
        client.bridge.onError((error) => {
          if (state.transport === 'ssh') {
            if (this.canConnect(state)) void this.refreshServices().catch(() => {})
            return
          }
          state.error = error.message
          this.publish()
        }),
        client.bridge.onSessionsChanged(() => {
          if (this.canConnect(state)) void this.refresh(state.id).catch(() => {})
        }),
      ]
      this.disposers.set(state.id, disposers)
    }
    if (!this.canConnect(state)) {
      this.refreshes.delete(state.id)
      this.get(state.id).suspend(state.error ?? '远程连接当前不可用，请恢复连接或处理连接问题')
    }
    return this.canConnect(state) && (fresh || !wasConnectable)
  }
  private drop(id: string) {
    for (const dispose of this.disposers.get(id) ?? []) dispose()
    this.disposers.delete(id)
    this.clients.get(id)?.close()
    this.clients.delete(id)
    this.states.delete(id)
    this.refreshes.delete(id)
  }
  private refreshServices() {
    if (this.closed) return Promise.resolve()
    this.serviceRefreshRequested = true
    if (this.serviceRefresh) return this.serviceRefresh
    const pending = (async () => {
      while (this.serviceRefreshRequested && !this.closed) {
        this.serviceRefreshRequested = false
        const states = await this.local.rpc<HostService[]>('host:services:list', [], null)
        if (this.closed) return
        if (this.serviceRefreshRequested) continue
        const current = new Set(states.map((state) => state.id))
        for (const id of this.states.keys()) if (id !== this.localServiceId && !current.has(id)) this.drop(id)
        const reconnect: string[] = []
        for (const state of states) if (this.accept(state)) reconnect.push(state.id)
        this.publish()
        if (this.initialized) for (const id of reconnect) void this.refresh(id).catch(() => {})
      }
    })().finally(() => {
      if (this.serviceRefresh === pending) this.serviceRefresh = undefined
    })
    this.serviceRefresh = pending
    return pending
  }
  private async changeSsh<T>(method: 'save' | 'enabled' | 'retry' | 'remove', args: unknown[]) {
    const result = await this.local.rpc<T>(`host:ssh:${method}`, args, null)
    if (method === 'remove' && typeof args[0] === 'string') this.drop(args[0])
    await this.refreshServices()
    return result
  }
  async initialize() {
    await this.refreshServices()
    this.initialized = true
    await Promise.allSettled(
      this.list()
        .filter((state) => this.canConnect(state))
        .map((state) => this.refresh(state.id)),
    )
  }
  async register(input: HostServiceRegistration) {
    const state = await this.local.rpc<HostService>('host:services:register', [input], null)
    this.accept(state)
    this.publish()
    await this.refresh(state.id)
    return this.states.get(state.id)!
  }
  async retry(id: string) {
    if (this.states.get(id)?.transport === 'ssh') {
      await this.ssh.retry(id)
      return
    }
    const state = await this.local.rpc<HostService>('host:services:retry', [id], null)
    this.accept(state)
    this.publish()
    await this.refresh(id)
  }
  async remove(id: string) {
    if (id === this.localServiceId) throw new Error('不能移除本机服务')
    if (this.states.get(id)?.transport === 'ssh') {
      await this.ssh.remove(id)
      return
    }
    await this.local.rpc('host:services:remove', [id], null)
    this.drop(id)
    this.publish()
  }
  async refresh(id: string) {
    const state = this.states.get(id)
    if (!state) throw new Error('服务不存在')
    if (!this.canConnect(state)) return
    const client = this.get(id)
    const refresh = Symbol(id)
    this.refreshes.set(id, refresh)
    const isCurrent = () => !this.closed && this.refreshes.get(id) === refresh && this.canConnect(state)
    if (state.transport !== 'ssh' && state.status !== 'connected') {
      state.status = 'connecting'
      this.publish()
    }
    let connected = false
    try {
      if (state.transport === 'ssh') await client.resume()
      else await client.connect()
      connected = true
      if (!isCurrent()) return
      if (state.transport !== 'ssh' && state.status === 'connecting') {
        state.status = 'connected'
        this.publish()
      }
      const [projects, sessions] = await Promise.all([client.bridge.getProjects(), client.bridge.getSessions()])
      if (!isCurrent()) return
      state.projects = projects
      state.sessions = sessions
      state.hostId = client.hostId
      if (state.transport !== 'ssh') {
        state.status = 'connected'
        delete state.error
      }
    } catch (cause) {
      if (isCurrent() && state.transport !== 'ssh') {
        if (!connected) state.status = 'disconnected'
        state.error = cause instanceof Error ? cause.message : String(cause)
      }
      throw cause
    } finally {
      if (isCurrent()) {
        this.refreshes.delete(id)
        this.publish()
      }
    }
  }
  close() {
    this.closed = true
    for (const disposers of this.disposers.values()) for (const dispose of disposers) dispose()
    this.disposers.clear()
    this.refreshes.clear()
    for (const client of this.clients.values()) client.close()
    this.listeners.clear()
  }
}
