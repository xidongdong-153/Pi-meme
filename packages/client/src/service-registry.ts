import type { HostService, HostServiceRegistration, PlatformAdapter } from '@pi-meme/contracts/host'
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
  readonly localServiceId = 'local'
  constructor(
    readonly local: HostClient,
    private readonly options: ServiceRegistryOptions,
  ) {
    this.clients.set(this.localServiceId, local)
    this.disposers.set(this.localServiceId, [
      local.bridge.onSessionsChanged(() => {
        void this.refresh(this.localServiceId).catch(() => {})
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
  private accept(state: HostService) {
    const existing = this.states.get(state.id)
    if (existing) {
      Object.assign(existing, state)
      state = existing
    }
    this.states.set(state.id, state)
    if (!this.clients.has(state.id)) {
      const client = new HostClient({
        ...this.options,
        connection: { url: state.address, hostId: state.hostId, local: false, token: '' },
        endpoint: { baseUrl: this.options.baseUrl, apiPrefix: `/api/services/${state.id}`, authenticate: true },
        platform: undefined,
      })
      this.clients.set(state.id, client)
      const disposers = [
        client.bridge.onConnection((connection) => {
          state.status = connection.status === 'disconnected' ? 'disconnected' : 'connected'
          state.error = connection.error
          this.publish()
        }),
        client.bridge.onError((error) => {
          state.error = error.message
          this.publish()
        }),
        client.bridge.onSessionsChanged(() => {
          void this.refresh(state.id).catch(() => {})
        }),
      ]
      this.disposers.set(state.id, disposers)
    }
    this.publish()
  }
  async initialize() {
    for (const state of await this.local.rpc<HostService[]>('host:services:list', [], null)) this.accept(state)
    await Promise.allSettled(this.list().map((state) => this.refresh(state.id)))
  }
  async register(input: HostServiceRegistration) {
    const state = await this.local.rpc<HostService>('host:services:register', [input], null)
    this.accept(state)
    await this.refresh(state.id)
    return this.states.get(state.id)!
  }
  async retry(id: string) {
    const state = await this.local.rpc<HostService>('host:services:retry', [id], null)
    this.accept(state)
    await this.refresh(id)
  }
  async remove(id: string) {
    if (id === this.localServiceId) throw new Error('不能移除本机服务')
    await this.local.rpc('host:services:remove', [id], null)
    for (const dispose of this.disposers.get(id) ?? []) dispose()
    this.disposers.delete(id)
    this.clients.get(id)?.close()
    this.clients.delete(id)
    this.states.delete(id)
    this.publish()
  }
  async refresh(id: string) {
    const state = this.states.get(id)
    if (!state) throw new Error('服务不存在')
    const client = this.get(id)
    state.status = 'connecting'
    this.publish()
    try {
      await client.connect()
      const [projects, sessions] = await Promise.all([client.bridge.getProjects(), client.bridge.getSessions()])
      state.projects = projects
      state.sessions = sessions
      state.hostId = client.hostId
      state.status = 'connected'
      delete state.error
    } catch (cause) {
      state.status = 'disconnected'
      state.error = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      this.publish()
    }
  }
  close() {
    for (const disposers of this.disposers.values()) for (const dispose of disposers) dispose()
    this.disposers.clear()
    for (const client of this.clients.values()) client.close()
    this.listeners.clear()
  }
}
