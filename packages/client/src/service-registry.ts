import type { ClientService, HostService, HostServiceRegistration, PlatformAdapter } from '@pi-meme/contracts/host'
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

/** 同一读取共用结果。收到变更后中止旧读取，等待者一起取得最新一轮结果。 */
class ServiceRefresh {
  private controller?: AbortController
  private pending?: Promise<void>
  private requested = false

  constructor(private readonly read: (signal: AbortSignal) => Promise<void>) {}

  run(invalidated = false): Promise<void> {
    if (this.pending && !invalidated) return this.pending
    this.requested = true
    this.controller?.abort()
    return (this.pending ??= Promise.resolve().then(async () => {
      try {
        while (this.requested) {
          this.requested = false
          const controller = new AbortController()
          this.controller = controller
          try {
            await this.read(controller.signal)
          } catch (cause) {
            if (!controller.signal.aborted) throw cause
          }
        }
      } finally {
        this.controller = undefined
        this.pending = undefined
      }
    }))
  }

  cancel() {
    this.requested = false
    this.controller?.abort()
  }
}

export class HostServiceRegistry {
  private readonly clients = new Map<string, HostClient>()
  private readonly states = new Map<string, ClientService>()
  private readonly disposers = new Map<string, Array<() => void>>()
  private readonly listeners = new Set<() => void>()
  private readonly refreshes = new Map<string, ServiceRefresh>()
  private readonly dirtyServices = new Set<string>()
  private readonly onVisible = () => {
    if (typeof document !== 'undefined' && !document.hidden)
      for (const id of this.dirtyServices) void this.refresh(id, true).catch(() => {})
  }
  private readonly directory = new ServiceRefresh(async (signal) => {
    const previousSummaries = new Map([...this.states].map(([id, state]) => [id, state.sessions]))
    const states = await this.local.rpc<HostService[]>('host:services:list', [], null, signal)
    signal.throwIfAborted()
    const current = new Set(states.map((state) => state.id))
    for (const id of this.states.keys()) if (id !== this.localServiceId && !current.has(id)) this.drop(id)
    const reconnect = states.filter((state) => this.accept(state, previousSummaries.get(state.id)))
    this.publish()
    if (this.initialized) for (const state of reconnect) void this.refresh(state.id, true).catch(() => {})
  })
  private initialized = false
  private closed = false
  readonly localServiceId = 'local'
  readonly ssh = {
    capabilities: (signal?: AbortSignal) => this.local.rpc<SshCapabilities>('host:ssh:capabilities', [], null, signal),
    list: (signal?: AbortSignal) => this.local.rpc<SshConnection[]>('host:ssh:list', [], null, signal),
    discover: (signal?: AbortSignal) => this.local.rpc<SshCandidate[]>('host:ssh:discover', [], null, signal),
    save: (input: SshConnectionInput) => this.changeSsh<SshConnection>('save', [input]),
    setEnabled: (id: string, enabled: boolean) => this.changeSsh<SshConnection>('enabled', [id, enabled]),
    retry: (id: string) => this.changeSsh<SshConnection>('retry', [id]),
    remove: (id: string) => this.changeSsh<void>('remove', [id]),
  }

  constructor(
    readonly local: HostClient,
    private readonly options: ServiceRegistryOptions,
  ) {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible)
    this.clients.set(this.localServiceId, local)
    this.disposers.set(this.localServiceId, [
      local.bridge.onSessionsChanged(() => {
        void this.refresh(this.localServiceId, true).catch(() => {})
      }),
      local.onServicesChanged(() => {
        void this.directory.run(true).catch(() => {})
      }),
      local.onTransportConnection((connected) => {
        this.transportChanged(this.localServiceId, connected)
        if (connected) void this.directory.run(true).catch(() => {})
      }),
    ])
    this.states.set(this.localServiceId, {
      id: this.localServiceId,
      hostId: local.hostId,
      address: local.hostAddress,
      local: true,
      clientStatus: local.transportConnected ? 'connected' : 'disconnected',
      projects: [],
    })
  }
  list() {
    return [...this.states.values()].map((state) => ({ ...state }))
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
  private canConnect(state: ClientService) {
    return state.transport !== 'ssh' || (state.enabled === true && state.phase === 'connected')
  }
  private transportChanged(id: string, connected: boolean) {
    const state = this.states.get(id)
    if (this.closed || !state) return
    state.clientStatus = connected ? 'connected' : 'disconnected'
    state.clientError = connected || !this.canConnect(state) ? undefined : '当前客户端连接已断开，正在重连'
    this.publish()
  }
  private accept(host: HostService, previousSummary: HostService['sessions']) {
    const id = host.id
    const previous = this.states.get(id)
    if (previous && (previous.hostId !== host.hostId || previous.address !== host.address)) this.drop(id)
    const fresh = !this.clients.has(id)
    const state: ClientService = {
      ...host,
      clientStatus: previous && !fresh ? previous.clientStatus : 'disconnected',
      clientError: previous && !fresh ? previous.clientError : undefined,
    }
    if (!fresh && previous && previous.sessions !== previousSummary) {
      state.projects = previous.projects
      state.sessions = previous.sessions
    }
    this.states.set(id, state)
    if (fresh) {
      const client = new HostClient({
        ...this.options,
        connection: { url: state.address, hostId: state.hostId, local: false, token: '' },
        endpoint: { baseUrl: this.options.baseUrl, apiPrefix: `/api/services/${id}`, authenticate: true },
        platform: undefined,
      })
      this.clients.set(id, client)
      this.disposers.set(id, [
        client.onTransportConnection((connected) => {
          this.transportChanged(id, connected)
          if (!connected && this.states.get(id)?.phase === 'connected') void this.directory.run().catch(() => {})
        }),
        client.bridge.onError((error) => {
          const current = this.states.get(id)
          if (!current || !this.canConnect(current)) return
          current.clientError = error.message
          this.publish()
        }),
        client.bridge.onSessionsChanged(() => void this.refresh(id, true).catch(() => {})),
      ])
    }
    if (!this.canConnect(state)) {
      this.refreshes.get(id)?.cancel()
      this.get(id).suspend(state.error ?? '远程连接当前不可用，请恢复连接或处理连接问题')
      state.clientStatus = 'disconnected'
      delete state.clientError
      return false
    }
    return fresh || !previous || !this.canConnect(previous)
  }
  private drop(id: string) {
    this.refreshes.get(id)?.cancel()
    this.refreshes.delete(id)
    this.dirtyServices.delete(id)
    for (const dispose of this.disposers.get(id) ?? []) dispose()
    this.disposers.delete(id)
    this.clients.get(id)?.close()
    this.clients.delete(id)
    this.states.delete(id)
  }
  private async changeSsh<T>(method: 'save' | 'enabled' | 'retry' | 'remove', args: unknown[]) {
    const result = await this.local.rpc<T>(`host:ssh:${method}`, args, null)
    if (!this.closed) await this.directory.run(true)
    return result
  }
  async initialize() {
    if (this.closed) return
    await this.directory.run()
    this.initialized = true
    await Promise.allSettled(
      this.list()
        .filter((state) => this.canConnect(state))
        .map((state) => this.refresh(state.id)),
    )
  }
  async register(input: HostServiceRegistration) {
    const result = await this.local.rpc<HostService>('host:services:register', [input], null)
    await this.directory.run(true)
    await this.refresh(result.id)
    const current = this.states.get(result.id)
    if (!current) throw new Error('服务已移除')
    return { ...current }
  }
  async retry(id: string) {
    const state = this.states.get(id)
    if (state?.status === 'connected' && state.clientStatus !== 'connected') {
      await this.refresh(id)
      return
    }
    if (state?.transport === 'ssh') {
      await this.ssh.retry(id)
      return
    }
    await this.local.rpc<HostService>('host:services:retry', [id], null)
    await this.directory.run(true)
    await this.refresh(id)
  }
  async remove(id: string) {
    if (id === this.localServiceId) throw new Error('不能移除本机服务')
    if (this.states.get(id)?.transport === 'ssh') {
      await this.ssh.remove(id)
      return
    }
    await this.local.rpc('host:services:remove', [id], null)
    await this.directory.run(true)
  }
  refresh(id: string, invalidated = false): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (typeof document !== 'undefined' && document.hidden) {
      this.dirtyServices.add(id)
      this.refreshes.get(id)?.cancel()
      return Promise.resolve()
    }
    this.dirtyServices.delete(id)
    let refresh = this.refreshes.get(id)
    if (!refresh) {
      refresh = new ServiceRefresh((signal) => this.refreshOnce(id, signal))
      this.refreshes.set(id, refresh)
    }
    return refresh.run(invalidated)
  }
  private async refreshOnce(id: string, signal: AbortSignal) {
    const state = this.states.get(id)
    if (!state) throw new Error('服务不存在')
    if (!this.canConnect(state)) return
    const client = this.get(id)
    if (!client.transportConnected) {
      state.clientStatus = 'connecting'
      this.publish()
    }
    try {
      if (state.transport === 'ssh') await client.resume()
      else await client.connect()
      signal.throwIfAborted()
      const [projects, sessions] = await Promise.all([
        client.rpc<HostService['projects']>('workspace:projects', [], undefined, signal),
        client.rpc<NonNullable<HostService['sessions']>>('pi:sessions', [], undefined, signal),
      ])
      signal.throwIfAborted()
      const current = this.states.get(id)!
      current.projects = projects
      current.sessions = sessions
      if (current.local) current.hostId = client.hostId
      current.clientStatus = client.transportConnected ? 'connected' : 'disconnected'
      if (client.transportConnected) delete current.clientError
      this.publish()
    } catch (cause) {
      if (!signal.aborted) {
        const current = this.states.get(id)!
        current.clientStatus = client.transportConnected ? 'connected' : 'disconnected'
        current.clientError = cause instanceof Error ? cause.message : String(cause)
        this.publish()
      }
      throw cause
    }
  }
  close() {
    this.closed = true
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible)
    this.directory.cancel()
    for (const id of this.states.keys()) this.drop(id)
    this.listeners.clear()
  }
}
