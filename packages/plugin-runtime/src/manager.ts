import type { HostApi } from '@pi-meme/contracts/app-host'
import { createHash, randomUUID } from 'node:crypto'
import { emptyPluginGrant, type PluginGrant, type PluginGrantUpdate } from '@pi-meme/plugin-sdk/permissions'
import type { PluginCallContext, PluginUiLease, JsonValue } from '@pi-meme/plugin-sdk/rpc'
import type { PluginOperation, PluginHandlers, ServerPluginModule } from '@pi-meme/plugin-sdk/server'
import { authorizeOperation, checkSchema, checkedJson, validateOperation } from './operation'
import { validatePluginGrant } from './grant'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Facet, FacetHost } from '@earendil-works/chord'
import type { FacetBundleArtifact } from '@earendil-works/chord/node'
import { parsePluginManifest, type PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import { assertExternalPluginId, assertExternalManifest, isReservedPluginId } from '@pi-meme/plugin-sdk/reserved'
import { legacySystemPluginIds } from '@pi-meme/plugin-sdk/system-plugins'
import type { AgentPluginEntry } from '@pi-meme/plugin-sdk/agent'
import { PluginScope } from '@pi-meme/plugin-sdk/scope'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import { packPlugin, readPluginManifest, unpackPlugin } from './package'
import { installedState, readInstalledState, writeInstalledState, type SavedPlugin } from './installed-state'

export type PluginResourcePackage = {
  id: string
  version: string
  generation: number
  directory: string
  enabled: boolean
  display?: PluginManifest['piMeme']['display']
  resources?: PluginManifest['piMeme']['resources']
}

export type PluginDescriptor = UiPluginDescriptor & {
  directory: string
  agent?: string
  requires: string[]
  provides: string[]
}
export type PluginLease = {
  retainedIds: string[]
  agentEntries: AgentPluginEntry[]
  descriptors: PluginDescriptor[]
  handlers: PluginHandlers
  runHandler: (channel: string, args?: unknown[]) => Promise<unknown>
  release: () => Promise<void>
  callOperation: (
    pluginId: string,
    operation: string,
    input: JsonValue,
    context: PluginCallContext,
  ) => Promise<JsonValue>
}
export type PluginManagerOptions = {
  directory: string
  dataDirectory: string
  stateFile: string
  hostApi?: HostApi
  hostApiForPlugin?: (id: string) => HostApi
  disposePluginHost?: (id: string) => Promise<void>
  validateResources?: (pkg: PluginResourcePackage) => Promise<void>
  drain?: (pluginIds: string[]) => Promise<void>
  revoke?: (pluginIds: string[]) => Promise<void>
  onChange?: (plugins: PluginDescriptor[]) => void
  reservedHandlers?: string[]
}
type Registration = {
  manifest: PluginManifest
  directory: string
  module?: ServerPluginModule
  artifact?: FacetBundleArtifact
  enabled: boolean
  sourceDirectory?: string
  policyHash?: string
  grant?: PluginGrant
}
type Group = {
  ids: Set<string>
  generation: number
  registrations: Registration[]
  handlers: PluginHandlers
  pluginOperations: Map<string, PluginOperation>
  host: FacetHost
  scope: PluginScope
  references: number
  retired: boolean
}
export type PluginDiagnostic = { id?: string; directory?: string; message: string }

export class PluginManager {
  private registrations = new Map<string, Registration>()
  private groups = new Set<Group>()
  private retired = new Set<Group>()
  private pending = new Set<string>()
  private revoking = new Set<string>()
  private records = new Map<string, SavedPlugin>()
  private failures = new Map<string, PluginDiagnostic>()
  private restoreDiagnostics: PluginDiagnostic[] = []
  private stateFailure?: Error
  private generation = 0
  private stateLoaded = false
  private readonly operations = new Set<Promise<unknown>>()
  private publishTail: Promise<unknown> = Promise.resolve()
  private idleWaiters = new Set<() => void>()
  private disposed = false
  private restoring = false
  private uiLeases = new Map<
    string,
    { lease: PluginUiLease; owner: string; route: string; group: Group; timer: ReturnType<typeof setTimeout> }
  >()
  private shared = new Map<string, { value: JsonValue; revision: number }>()
  constructor(private readonly options: PluginManagerOptions) {}

  private track<T>(operation: () => Promise<T>): Promise<T> {
    const next = Promise.resolve().then(async () => {
      if (this.disposed) throw new Error('插件管理器已关闭')
      if (!this.stateLoaded) await this.publish(() => this.loadState())
      if (this.stateFailure) throw this.stateFailure
      return operation()
    })
    this.operations.add(next)
    void next.finally(() => this.operations.delete(next)).catch(() => {})
    return next
  }

  private publish<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.publishTail.catch(() => {}).then(operation)
    this.publishTail = next
    return next
  }

  private descriptor(registration: Registration, generation?: number): PluginDescriptor {
    const { manifest, directory, enabled } = registration
    const active = generation ?? [...this.groups].find((group) => group.ids.has(manifest.name))?.generation ?? 0
    const operations = [...this.groups, ...this.retired].find(
      (group) => group.generation === active && group.ids.has(manifest.name),
    )?.pluginOperations
    return {
      id: manifest.name,
      version: manifest.version,
      description: manifest.description,
      display: manifest.piMeme.display,
      resources: manifest.piMeme.resources,
      capabilities: {
        server: Boolean(manifest.piMeme.server),
        agent: Boolean(manifest.piMeme.agent),
        ui: Boolean(manifest.piMeme.ui),
        resources: Object.values(manifest.piMeme.resources ?? {}).some((paths) => paths.length > 0),
      },
      operations: [...(operations?.entries() ?? [])]
        .filter(([key]) => key.startsWith(`${manifest.name}:`))
        .map(([, operation]) => ({
          name: operation.name,
          effect: operation.effect,
          audience: [...operation.audience],
        })),
      permissions: manifest.piMeme.permissions,
      policyHash: registration.policyHash,
      grantChanging: this.revoking.has(manifest.name),
      grant: registration.grant ?? emptyPluginGrant(registration.policyHash ?? ''),
      entries: {
        agent: {
          trusted: Boolean(manifest.piMeme.agent?.trusted),
          restricted: Boolean(manifest.piMeme.agent?.restricted),
        },
        server: {
          trusted: Boolean(manifest.piMeme.server?.trusted),
          restricted: Boolean(manifest.piMeme.server?.restricted),
        },
      },
      generation: active,
      directory,
      enabled,
      status: this.pending.has(manifest.name)
        ? 'pending'
        : this.failures.has(manifest.name)
          ? 'failed'
          : enabled
            ? 'active'
            : 'disabled',
      error: this.failures.get(manifest.name)?.message,
      ui: this.failures.has(manifest.name) ? undefined : manifest.piMeme.ui,
      agent: this.failures.has(manifest.name)
        ? undefined
        : (manifest.piMeme.agent?.restricted ?? manifest.piMeme.agent?.trusted),
      requires: manifest.piMeme.requires ?? [],
      provides: manifest.piMeme.provides ?? [],
    }
  }

  list() {
    const descriptors = [...this.registrations.values()].map((registration) => this.descriptor(registration))
    for (const [id, entry] of this.records) {
      if (this.registrations.has(id) || isReservedPluginId(id) || !this.failures.has(id)) continue
      descriptors.push({
        id,
        version: '未知',
        directory: entry.directory,
        generation: 0,
        enabled: entry.enabled,
        status: 'failed',
        error: this.failures.get(id)!.message,
        requires: [],
        provides: [],
      })
    }
    return descriptors
  }
  async setGrant(id: string, update: PluginGrantUpdate) {
    return this.track(async () => {
      const registration = this.registrations.get(id)
      if (!registration || update.policyHash !== registration.policyHash)
        throw new Error('policy-changed: 插件代码已变化')
      const previous = registration.grant ?? emptyPluginGrant(registration.policyHash ?? '')
      if (previous.revision !== update.expectedRevision) throw new Error('policy-changed: 授权修订已变化')
      const grant = validatePluginGrant(registration.manifest, registration.policyHash!, {
        ...update,
        revision: previous.revision + 1,
      })
      return this.withRevocation(id, async () => {
        if (
          this.registrations.get(id)?.policyHash !== registration.policyHash ||
          this.registrations.get(id)?.grant?.revision !== previous.revision
        )
          throw new Error('policy-changed: 授权变更期间代码或修订已变化')
        const next = new Map(this.registrations)
        next.set(id, { ...registration, grant })
        await this.transition(next, [id])
        return this.list().find((item) => item.id === id)!
      })
    })
  }
  private async withRevocation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.pending.has(id) || this.revoking.has(id))
      throw new Error('policy-changed: 插件依赖组正在切换版本，请稍后重试')
    this.revoking.add(id)
    this.pending.add(id)
    this.changed()
    try {
      for (const entry of [...this.uiLeases.values()])
        if (entry.lease.pluginId === id) await this.releaseUiLease(entry.owner, entry.lease.id)
      await this.options.revoke?.([id])
      await this.options.drain?.([id])
      this.pending.delete(id)
      return await operation()
    } finally {
      this.revoking.delete(id)
      this.pending.delete(id)
      this.changed()
    }
  }
  isGrantCurrent(pluginId: string, generation: number, revision: number) {
    return (
      this.registrations.get(pluginId)?.enabled === true &&
      !this.revoking.has(pluginId) &&
      this.getGeneration(pluginId, generation)?.grant?.revision === revision
    )
  }
  readSharedData(pluginId: string, key: string, scope = '') {
    const value =
      this.shared.get(JSON.stringify([pluginId, scope, key])) ?? this.shared.get(JSON.stringify([pluginId, '', key]))
    if (!value) throw new Error('operation-not-found: 共享记录不存在')
    return structuredClone(value)
  }
  private async invokeOperation(
    group: Group,
    pluginId: string,
    operation: string,
    input: JsonValue,
    context: PluginCallContext,
  ) {
    if (this.revoking.has(pluginId)) throw new Error('policy-changed: 插件授权正在撤销')
    const definition = group.pluginOperations.get(`${pluginId}:${operation}`)
    if (!definition) throw new Error('operation-not-found: 插件未注册此操作')
    authorizeOperation(definition, context)
    checkSchema(definition.inputSchema, input)
    if (context.signal.aborted) throw new Error('cancelled: 调用已取消')
    group.references++
    try {
      const policyHash = group.registrations.find((item) => item.manifest.name === pluginId)?.policyHash
      const result = await definition.execute(input, { ...context, policyHash })
      if (context.signal.aborted || this.revoking.has(pluginId)) throw new Error('cancelled: 调用已取消或授权变化')
      checkSchema(definition.outputSchema, result, true)
      return result
    } finally {
      await this.release(group)
    }
  }
  acquireUiLease(owner: string, input: { pluginId: string; generation: number; routeInstance: string }): PluginUiLease {
    if (this.uiLeases.size >= 128 || !input.routeInstance) throw new Error('permission-denied: 编辑租约数量或来源无效')
    const group = [...this.groups].find((g) => g.generation === input.generation && g.ids.has(input.pluginId))
    const registration = group?.registrations.find((r) => r.manifest.name === input.pluginId)
    if (!group || !registration?.grant?.trusted.ui || this.pending.has(input.pluginId))
      throw new Error('generation-mismatch: 此 UI 代次不可编辑')
    const lease = {
      id: randomUUID(),
      pluginId: input.pluginId,
      generation: input.generation,
      expiresAt: Date.now() + 60000,
    }
    group.references++
    const timer = setTimeout(() => {
      void this.releaseUiLease(owner, lease.id)
    }, 60000)
    timer.unref()
    this.uiLeases.set(lease.id, { lease, owner, route: input.routeInstance, group, timer })
    return { ...lease }
  }
  renewUiLease(owner: string, id: string) {
    const entry = this.uiLeases.get(id)
    if (!entry || entry.owner !== owner || entry.lease.expiresAt <= Date.now())
      throw new Error('scope-expired: 编辑租约已失效')
    clearTimeout(entry.timer)
    entry.lease.expiresAt = Date.now() + 60000
    entry.timer = setTimeout(() => {
      void this.releaseUiLease(owner, id)
    }, 60000)
    entry.timer.unref()
    return { ...entry.lease }
  }
  async releaseUiLease(owner: string, id: string) {
    const entry = this.uiLeases.get(id)
    if (!entry || entry.owner !== owner) return
    this.uiLeases.delete(id)
    clearTimeout(entry.timer)
    await this.release(entry.group)
  }
  async callUi(
    owner: string,
    request: import('@pi-meme/plugin-sdk/rpc').PluginCallRequest,
    context: PluginCallContext,
  ) {
    const held = request.leaseId ? this.uiLeases.get(request.leaseId) : undefined
    if (
      request.leaseId &&
      (!held ||
        held.owner !== owner ||
        held.lease.pluginId !== request.pluginId ||
        held.lease.generation !== request.generation ||
        held.lease.expiresAt <= Date.now())
    )
      throw new Error('scope-expired: 编辑租约已失效')
    const group =
      held?.group ?? [...this.groups].find((g) => g.generation === request.generation && g.ids.has(request.pluginId))
    const registration = group?.registrations.find((r) => r.manifest.name === request.pluginId)
    if (!group || !registration?.grant?.trusted.ui || (this.pending.has(request.pluginId) && !held))
      throw new Error('generation-mismatch: UI 与 Server 代次不可调用')
    if (!request.policyHash || request.policyHash !== registration.policyHash)
      throw new Error('policy-changed: UI 调用不属于此代码快照')
    if (!registration.manifest.piMeme.server?.trusted)
      throw new Error('operation-unavailable-in-runtime: UI 只能调用本插件可信 Server')
    if (!registration.grant.trusted.server) throw new Error('grant-required: 尚未信任 Server 入口')
    return this.invokeOperation(group, request.pluginId, request.operation, request.input, context)
  }
  diagnostics(): PluginDiagnostic[] {
    return [...this.restoreDiagnostics, ...this.failures.values()]
  }
  resourcePackages(): PluginResourcePackage[] {
    return [...this.registrations.values()].map((registration) => {
      const descriptor = this.descriptor(registration)
      return {
        id: descriptor.id,
        version: descriptor.version,
        generation: descriptor.generation,
        directory: descriptor.directory,
        enabled: descriptor.enabled && descriptor.status !== 'failed',
        display: registration.manifest.piMeme.display,
        resources: registration.manifest.piMeme.resources,
      }
    })
  }
  getGeneration(id: string, generation: number): PluginDescriptor | undefined {
    const group = [...this.groups, ...this.retired].find((item) => item.generation === generation && item.ids.has(id))
    const registration = group?.registrations.find((item) => item.manifest.name === id)
    if (registration) return this.descriptor(registration, generation)
    const installed = this.registrations.get(id)
    if (generation === 0 && installed && this.descriptor(installed).generation === 0) return this.descriptor(installed)
    return undefined
  }
  private changed() {
    this.options.onChange?.(this.list())
  }

  handlers(): PluginHandlers {
    const handlers: PluginHandlers = {}
    for (const group of this.groups) {
      for (const [channel, handler] of Object.entries(group.handlers)) {
        handlers[channel] = async (...args) => {
          if (group.retired || [...group.ids].some((id) => this.pending.has(id)))
            throw new Error('插件正在切换版本，请稍后重试')
          group.references++
          try {
            return await handler(...args)
          } finally {
            await this.release(group)
          }
        }
      }
    }
    return handlers
  }

  async runHandler(channel: string, args: unknown[] = []) {
    const handler = this.handlers()[channel]
    if (!handler) throw new Error(`插件操作未注册：${channel}`)
    return handler(...args)
  }

  private components(registrations: Map<string, Registration>, retry = new Set<string>()) {
    const active = [...registrations.values()].filter(
      (item) => item.enabled && (!this.failures.has(item.manifest.name) || retry.has(item.manifest.name)),
    )
    const provider = new Map<string, Registration>()
    for (const item of active) {
      for (const name of item.manifest.piMeme.provides ?? []) {
        if (provider.has(name)) throw new Error(`服务已有提供者：${name}`)
        provider.set(name, item)
      }
    }
    for (const item of active) {
      for (const name of item.manifest.piMeme.requires ?? []) {
        if (!provider.has(name)) throw new Error(`${item.manifest.name} 所需服务不可用：${name}`)
      }
    }
    const components: Registration[][] = []
    const remaining = new Set(active)
    while (remaining.size) {
      const seed = remaining.values().next().value as Registration
      const component = new Set([seed])
      remaining.delete(seed)
      let expanded = true
      while (expanded) {
        expanded = false
        for (const item of remaining) {
          const connected = [...component].some(
            (member) =>
              (item.manifest.piMeme.requires ?? []).some((name) => provider.get(name) === member) ||
              (member.manifest.piMeme.requires ?? []).some((name) => provider.get(name) === item),
          )
          if (connected) {
            component.add(item)
            remaining.delete(item)
            expanded = true
          }
        }
      }
      const ordered: Registration[] = []
      const visited = new Set<Registration>()
      const visiting = new Set<Registration>()
      const visit = (item: Registration) => {
        if (visited.has(item)) return
        if (visiting.has(item)) throw new Error(`插件服务依赖存在循环：${item.manifest.name}`)
        visiting.add(item)
        for (const required of item.manifest.piMeme.requires ?? []) {
          const dependency = provider.get(required)
          if (dependency) visit(dependency)
        }
        visiting.delete(item)
        visited.add(item)
        ordered.push(item)
      }
      for (const item of component) visit(item)
      components.push(ordered)
    }
    return components
  }

  private async startGroup(registrations: Registration[], generation: number): Promise<Group> {
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > this.generation)
      throw new Error('插件代次未完成持久预留')
    const { createFacetHost, defineFacet, defineService } = await import('@earendil-works/chord')
    const { createFacetBundleArtifactLoader } = await import('@earendil-works/chord/node')
    const scope = new PluginScope()
    const handlers: PluginHandlers = {}
    const pluginOperations = new Map<string, PluginOperation>()
    const facets: Facet[] = []
    const serviceDefinitions = new Map<string, ReturnType<typeof defineService<object>>>()
    const definition = (name: string) => {
      if (!serviceDefinitions.has(name)) serviceDefinitions.set(name, defineService<object>(name, { local: true }))
      return serviceDefinitions.get(name)!
    }
    try {
      for (const registration of registrations) {
        if (registration.artifact && registration.grant?.trusted.server) {
          const loaded = await createFacetBundleArtifactLoader({ artifact: registration.artifact }).load()
          scope.own(() => loaded.dispose())
          facets.push(...loaded.facets)
        }
        const pluginScope = new PluginScope()
        if (this.options.disposePluginHost)
          pluginScope.own(() => this.options.disposePluginHost!(registration.manifest.name))
        scope.own(() => pluginScope.dispose())
        const dataDirectory = path.join(this.options.dataDirectory, encodeURIComponent(registration.manifest.name))
        await mkdir(dataDirectory, { recursive: true })
        facets.push(
          defineFacet({
            id: `app:${registration.manifest.name}:${generation}`,
            setup: (env) => {
              const required = new Map<string, object>()
              for (const name of registration.grant?.trusted.server
                ? (registration.manifest.piMeme.requires ?? [])
                : [])
                required.set(name, env.use(definition(name)))
              const module =
                (registration.grant?.trusted.server ? registration.module : undefined) ??
                (registration.artifact && registration.grant?.trusted.server
                  ? env.use(
                      defineService<ServerPluginModule>(`pi-meme.plugin.module:${registration.manifest.name}`, {
                        local: true,
                      }),
                    )
                  : undefined)
              const provided = new Map<string, object>()
              for (const name of registration.grant?.trusted.server
                ? (registration.manifest.piMeme.provides ?? [])
                : []) {
                env.provide(
                  definition(name),
                  new Proxy(
                    {},
                    {
                      get: (_target, key) => {
                        const service = provided.get(name)
                        if (!service) throw new Error(`插件服务尚未初始化：${name}`)
                        const member = Reflect.get(service, key)
                        return typeof member === 'function' ? member.bind(service) : member
                      },
                    },
                  ),
                )
              }
              env.own(() => pluginScope.dispose())
              env.onActivate(async () => {
                if (module) {
                  if (typeof module.create !== 'function') throw new Error('插件 server 入口必须导出 create(context)')
                  const hostApi = this.options.hostApiForPlugin?.(registration.manifest.name) ?? this.options.hostApi
                  const instance = await module.create({
                    pluginId: registration.manifest.name,
                    generation,
                    dataDirectory,
                    get host() {
                      if (!hostApi) throw new Error('插件 Host API 未装配')
                      return hostApi
                    },
                    services: {
                      require: <T>(name: string) => {
                        if (!required.has(name)) throw new Error(`插件未声明所需服务：${name}`)
                        return required.get(name) as T
                      },
                    },
                    registerOperations: (values) => {
                      for (const operation of values) {
                        validateOperation(operation)
                        const key = `${registration.manifest.name}:${operation.name}`
                        if (pluginOperations.has(key)) throw new Error(`插件操作重复：${key}`)
                        pluginOperations.set(key, operation)
                      }
                      return pluginScope.own(() => {
                        for (const operation of values)
                          pluginOperations.delete(`${registration.manifest.name}:${operation.name}`)
                      })
                    },
                    sharedData: {
                      getSnapshot: async (key, options) => {
                        if (!/^[\w.-]+$/.test(key)) throw new Error('invalid-input: 共享数据名称无效')
                        const id = JSON.stringify([registration.manifest.name, options?.scope ?? '', key])
                        const snapshot = this.shared.get(id)
                        return snapshot ? structuredClone(snapshot) : undefined
                      },
                      publish: async (key, value, options) => {
                        checkedJson(value, 1048576)
                        if (!/^[\w.-]+$/.test(key)) throw new Error('invalid-input: 共享数据名称无效')
                        const id = JSON.stringify([registration.manifest.name, options.scope ?? '', key])
                        const previous = this.shared.get(id)
                        if ((previous?.revision ?? 0) !== options.expectedRevision)
                          throw new Error('policy-changed: 共享数据修订冲突')
                        const next = { value: structuredClone(value), revision: options.expectedRevision + 1 }
                        this.shared.set(id, next)
                        return structuredClone(next)
                      },
                    },
                    provide: (name, service) => {
                      if (!(registration.manifest.piMeme.provides ?? []).includes(name))
                        throw new Error(`插件未声明提供服务：${name}`)
                      if (
                        !service ||
                        (typeof service !== 'object' && typeof service !== 'function') ||
                        provided.has(name)
                      )
                        throw new Error(`插件服务必须是对象且不能重复：${name}`)
                      provided.set(name, service as object)
                      return pluginScope.own(() => {
                        provided.delete(name)
                      })
                    },
                    onDispose: (effect) => {
                      pluginScope.own(effect)
                    },
                  })
                  if (instance?.dispose) pluginScope.own(instance.dispose)
                }
                for (const name of registration.grant?.trusted.server
                  ? (registration.manifest.piMeme.provides ?? [])
                  : []) {
                  if (!provided.has(name)) throw new Error(`插件没有提供声明的服务：${name}`)
                }
              })
            },
          }),
        )
      }
      const host = await createFacetHost({ facets })
      return {
        ids: new Set(registrations.map((item) => item.manifest.name)),
        generation,
        registrations,
        handlers,
        pluginOperations,
        host,
        scope,
        references: 0,
        retired: false,
      }
    } catch (cause) {
      await scope.dispose().catch(() => {})
      throw cause
    }
  }

  private async disposeGroup(group: Group) {
    const errors: unknown[] = []
    try {
      await group.host.dispose()
    } catch (cause) {
      errors.push(cause)
    }
    try {
      await group.scope.dispose()
    } catch (cause) {
      errors.push(cause)
    }
    this.retired.delete(group)
    await this.pruneDirectories(group.registrations).catch(() => {})
    if (errors.length) throw new AggregateError(errors, '插件作用域释放失败')
  }

  private async pruneDirectories(registrations: Registration[]) {
    for (const registration of registrations) {
      if (!path.resolve(registration.directory).startsWith(`${path.resolve(this.options.directory)}${path.sep}`))
        continue
      const used =
        [...this.records.values()].some((item) => item.directory === registration.directory) ||
        [...this.registrations.values()].some((item) => item.directory === registration.directory) ||
        [...this.groups, ...this.retired].some((group) =>
          group.registrations.some((item) => item.directory === registration.directory),
        )
      if (!used) await rm(registration.directory, { recursive: true, force: true })
    }
  }

  private async release(group: Group) {
    group.references--
    try {
      if (!group.references && group.retired) await this.disposeGroup(group)
    } finally {
      for (const resolve of this.idleWaiters) resolve()
      this.idleWaiters.clear()
    }
  }

  private async loadState(force = false) {
    if (this.stateFailure) throw this.stateFailure
    if (this.stateLoaded && !force) return
    try {
      const state = await readInstalledState(this.options.stateFile)
      this.generation = Math.max(this.generation, state.generationHighWaterMark)
      this.records = new Map(state.records.map((item) => [item.id, item]))
      this.stateLoaded = true
    } catch (cause) {
      this.stateFailure = new Error(`插件清单读取失败；保留清单文件，本次不加载外部插件：${String(cause)}`)
      this.restoreDiagnostics.push({ message: this.stateFailure.message })
      throw this.stateFailure
    }
  }

  private async reserveGenerations(count: number) {
    if (this.stateFailure) throw this.stateFailure
    if (!count) return []
    if (!Number.isSafeInteger(count) || count < 0 || this.generation > Number.MAX_SAFE_INTEGER - count) {
      this.stateFailure = new Error('插件代次 safe integer 已溢出，保留安装记录并拒绝新激活')
      this.restoreDiagnostics.push({ message: this.stateFailure.message })
      throw this.stateFailure
    }
    const first = this.generation + 1
    this.generation += count
    try {
      await writeInstalledState(this.options.stateFile, installedState(this.generation, [...this.records.values()]))
    } catch (cause) {
      if (this.restoring) {
        this.stateFailure = new Error(`插件代次预留失败；本次不加载外部插件，后续变更未接纳：${String(cause)}`)
        this.restoreDiagnostics.push({ message: this.stateFailure.message })
      }
      throw cause
    }
    return Array.from({ length: count }, (_, index) => first + index)
  }

  private async writeState(registrations: Map<string, Registration>) {
    if (this.stateFailure) throw this.stateFailure
    const records = new Map(this.records)
    for (const id of this.registrations.keys()) if (!registrations.has(id)) records.delete(id)
    for (const item of registrations.values())
      records.set(item.manifest.name, {
        ...records.get(item.manifest.name),
        id: item.manifest.name,
        directory: item.directory,
        enabled: item.enabled,
        sourceDirectory: item.sourceDirectory,
        policyHash: item.policyHash,
        grant: item.grant,
      })
    await writeInstalledState(this.options.stateFile, installedState(this.generation, [...records.values()]))
    this.records = records
  }

  private async transition(next: Map<string, Registration>, changedIds: string[]) {
    const components = this.components(next, new Set(changedIds))
    const affected = new Set(changedIds)
    let expanded = true
    while (expanded) {
      expanded = false
      for (const ids of [
        ...[...this.groups].map((group) => [...group.ids]),
        ...components.map((items) => items.map((item) => item.manifest.name)),
      ]) {
        if (ids.some((id) => affected.has(id))) {
          for (const id of ids)
            if (!affected.has(id)) {
              affected.add(id)
              expanded = true
            }
        }
      }
    }
    if ([...affected].some((id) => this.pending.has(id))) throw new Error('插件依赖组正在切换版本，请稍后重试')
    for (const id of affected) this.pending.add(id)
    this.changed()
    const oldGroups = [...this.groups].filter((group) => [...group.ids].some((id) => affected.has(id)))
    const hasServer = [
      ...oldGroups.flatMap((group) => group.registrations),
      ...components.flat().filter((item) => affected.has(item.manifest.name)),
    ].some((item) => item.manifest.piMeme.server?.trusted && item.grant?.trusted.server)
    try {
      // 预留在排空旧使用者之前完成；等待旧组时不占用发布队列，其他组仍可更新。
      const reserved = await this.publish(() =>
        this.reserveGenerations(
          components.filter((items) => items.some((item) => affected.has(item.manifest.name))).length +
            oldGroups.length,
        ),
      )
      if (hasServer) {
        if (oldGroups.some((group) => group.references)) await this.options.drain?.([...affected])
        while (oldGroups.some((group) => group.references))
          await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
      }
      await this.publish(async () => {
        const previous = this.registrations
        const previousRecords = this.records
        const merged = new Map(previous)
        for (const id of changedIds) {
          const registration = next.get(id)
          if (registration) merged.set(id, registration)
          else merged.delete(id)
        }
        const targetComponents = this.components(merged, new Set(changedIds)).filter((items) =>
          items.some((item) => affected.has(item.manifest.name)),
        )
        const newGroups: Group[] = []
        const stopped: Group[] = []
        let persisted = false
        try {
          await this.writeState(merged)
          persisted = true
          if (hasServer) {
            for (const group of oldGroups) {
              this.groups.delete(group)
              stopped.push(group)
              await this.disposeGroup(group)
            }
          }
          for (const component of targetComponents) newGroups.push(await this.startGroup(component, reserved.shift()!))
          for (const group of oldGroups) {
            this.groups.delete(group)
            if (!hasServer) {
              group.retired = true
              this.retired.add(group)
              if (!group.references) await this.disposeGroup(group)
            }
          }
          for (const group of newGroups) this.groups.add(group)
          this.registrations = merged
          for (const id of changedIds) this.failures.delete(id)
          await this.pruneDirectories(
            oldGroups.filter((group) => !this.retired.has(group)).flatMap((group) => group.registrations),
          ).catch(() => {})
        } catch (cause) {
          const errors: unknown[] = [cause]
          for (const group of newGroups) await this.disposeGroup(group).catch((error: unknown) => errors.push(error))
          for (const group of stopped) {
            try {
              this.groups.add(await this.startGroup(group.registrations, reserved.shift()!))
            } catch (error) {
              errors.push(error)
            }
          }
          if (persisted) {
            this.records = previousRecords
            await this.writeState(previous).catch((error: unknown) => errors.push(error))
          }
          if (errors.length > 1) throw new AggregateError(errors, '插件更新失败，恢复旧版本时也发生错误')
          throw cause
        }
      })
    } finally {
      for (const id of affected) this.pending.delete(id)
      this.changed()
    }
  }

  private async fromDirectory(directory: string): Promise<Registration> {
    assertExternalManifest(
      parsePluginManifest(JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))),
    )
    const manifest = await readPluginManifest(directory)
    const { readFacetBundleArtifact } = await import('@earendil-works/chord/node')
    const artifact = manifest.piMeme.server?.trusted
      ? await readFacetBundleArtifact({
          manifestPath: path.join(directory, manifest.piMeme.server.trusted),
          entry: 'server',
        })
      : undefined
    if (
      artifact &&
      (artifact.plugin.id !== manifest.name ||
        (artifact.plugin.version && artifact.plugin.version !== manifest.version))
    )
      throw new Error('Chord 构建产物与插件身份或版本不匹配')
    const policyHash = createHash('sha256')
      .update(await packPlugin(directory))
      .digest('hex')
    const saved = this.records.get(manifest.name)
    let grant = emptyPluginGrant(policyHash)
    if (saved?.policyHash === policyHash && saved.grant?.policyHash === policyHash) {
      try {
        grant = validatePluginGrant(manifest, policyHash, saved.grant)
      } catch {
        this.restoreDiagnostics.push({ id: manifest.name, message: '插件授权记录损坏，已拒绝所有能力，请重新授权' })
      }
    }
    return { manifest, directory: path.resolve(directory), artifact, enabled: true, policyHash, grant }
  }

  private async validateResources(registration: Registration) {
    await this.options.validateResources?.({
      id: registration.manifest.name,
      version: registration.manifest.version,
      generation: 0,
      directory: registration.directory,
      enabled: true,
      display: registration.manifest.piMeme.display,
      resources: registration.manifest.piMeme.resources,
    })
  }

  private async replace(registration: Registration) {
    assertExternalManifest(registration.manifest)
    await this.validateResources(registration)
    const next = new Map(this.registrations)
    next.set(registration.manifest.name, registration)
    await this.transition(next, [registration.manifest.name])
    return this.descriptor(registration)
  }

  private async snapshotDirectory(directory: string) {
    assertExternalManifest(
      parsePluginManifest(JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))),
    )
    const buffer = await packPlugin(directory)
    await mkdir(this.options.directory, { recursive: true })
    const snapshot = await mkdtemp(path.join(this.options.directory, 'directory-'))
    try {
      await unpackPlugin(buffer, snapshot)
      const registration = await this.fromDirectory(snapshot)
      registration.sourceDirectory = path.resolve(directory)
      return registration
    } catch (cause) {
      if (
        ![...this.groups, ...this.retired].some((group) =>
          group.registrations.some((item) => item.directory === snapshot),
        )
      )
        await rm(snapshot, { recursive: true, force: true })
      throw cause
    }
  }

  loadDirectory(directory: string) {
    return this.track(async () => {
      const registration = await this.snapshotDirectory(directory)
      try {
        return await this.replace(registration)
      } catch (cause) {
        await this.pruneDirectories([registration]).catch(() => {})
        throw cause
      }
    })
  }

  reload(id: string) {
    return this.track(async () => {
      assertExternalPluginId(id)
      const previous =
        this.registrations.get(id) ??
        (this.records.has(id)
          ? {
              ...(await this.fromDirectory(this.records.get(id)!.directory)),
              enabled: this.records.get(id)!.enabled,
              sourceDirectory: this.records.get(id)!.sourceDirectory,
            }
          : undefined)
      if (!previous) throw new Error('插件不存在')
      const registration = previous.sourceDirectory
        ? await this.snapshotDirectory(previous.sourceDirectory)
        : { ...previous }
      registration.enabled = previous.enabled
      try {
        return await this.replace(registration)
      } catch (cause) {
        await this.pruneDirectories([registration]).catch(() => {})
        throw cause
      }
    })
  }
  installPackage(buffer: Buffer) {
    return this.track(async () => {
      await mkdir(this.options.directory, { recursive: true })
      const directory = await mkdtemp(path.join(this.options.directory, 'package-'))
      try {
        await unpackPlugin(buffer, directory)
        return await this.replace(await this.fromDirectory(directory))
      } catch (cause) {
        if (
          ![...this.groups, ...this.retired].some((group) =>
            group.registrations.some((item) => item.directory === directory),
          )
        )
          await rm(directory, { recursive: true, force: true })
        throw cause
      }
    })
  }
  enable(id: string) {
    return this.setEnabled(id, true)
  }
  disable(id: string) {
    return this.setEnabled(id, false)
  }
  private setEnabled(id: string, enabled: boolean) {
    return this.track(async () => {
      assertExternalPluginId(id)
      const current =
        this.registrations.get(id) ??
        (this.records.has(id)
          ? {
              ...(await this.fromDirectory(this.records.get(id)!.directory)),
              enabled: this.records.get(id)!.enabled,
              sourceDirectory: this.records.get(id)!.sourceDirectory,
            }
          : undefined)
      if (!current) throw new Error('插件不存在')
      const next = new Map(this.registrations)
      const registration = { ...current, enabled }
      if (enabled) await this.validateResources(registration)
      next.set(id, registration)
      if (enabled) await this.transition(next, [id])
      else {
        this.components(next, new Set([id]))
        await this.withRevocation(id, () => this.transition(next, [id]))
      }
      return this.descriptor(registration)
    })
  }
  remove(id: string) {
    return this.track(async () => {
      assertExternalPluginId(id)
      if (!this.registrations.has(id) && !this.records.has(id)) throw new Error('插件不存在')
      const next = new Map(this.registrations)
      next.delete(id)
      this.components(next)
      await this.withRevocation(id, async () => {
        if (!this.registrations.has(id)) {
          const record = this.records.get(id)!
          this.records.delete(id)
          try {
            await this.writeState(this.registrations)
          } catch (cause) {
            this.records.set(id, record)
            throw cause
          }
        } else await this.transition(next, [id])
        this.failures.delete(id)
      })
    })
  }
  acquire(
    isEnabled: (pluginId: string) => boolean = () => true,
    from?: ReadonlyArray<{ id: string; generation: number }>,
  ): PluginLease {
    if (this.disposed) throw new Error('插件管理器已关闭')
    const inherited =
      from && new Map(from.filter((item) => isEnabled(item.id)).map((item) => [item.id, item.generation]))
    const candidates = inherited ? [...this.groups, ...this.retired] : [...this.groups]
    if (inherited) {
      for (const [id, generation] of inherited) {
        if (this.revoking.has(id) || !this.registrations.get(id)?.enabled)
          throw new Error(`policy-changed: 父会话插件已停用、移除或正在撤销：${id}`)
        const group = candidates.find((group) => group.generation === generation && group.ids.has(id))
        if (!group || !group.references) throw new Error(`父会话插件代次已释放：${id} (${generation})`)
      }
    }
    const selected = (item: Registration) =>
      isEnabled(item.manifest.name) &&
      Boolean(item.manifest.piMeme.agent || item.manifest.piMeme.resources?.skills?.length)
    const current = candidates.filter((group) =>
      group.registrations.some(
        (item) => selected(item) && (!inherited || inherited.get(item.manifest.name) === group.generation),
      ),
    )
    if (!inherited && current.some((group) => [...group.ids].some((id) => this.pending.has(id))))
      throw new Error('会话插件正在切换版本，请稍后重试')
    for (const group of current) group.references++
    let released = false
    const handlers: PluginHandlers = {}
    for (const group of current) {
      for (const [channel, handler] of Object.entries(group.handlers)) {
        handlers[channel] = async (...args) => {
          if (released) throw new Error('插件租约已释放')
          group.references++
          try {
            return await handler(...args)
          } finally {
            await this.release(group)
          }
        }
      }
    }
    return {
      retainedIds: current.flatMap((group) => [...group.ids]),
      agentEntries: current.flatMap((group) =>
        group.registrations.flatMap((item) =>
          selected(item) &&
          (!inherited || inherited.get(item.manifest.name) === group.generation) &&
          item.manifest.piMeme.agent
            ? [
                {
                  pluginId: item.manifest.name,
                  generation: group.generation,
                  directory: item.directory,
                  trusted: item.manifest.piMeme.agent.trusted
                    ? path.join(item.directory, item.manifest.piMeme.agent.trusted)
                    : undefined,
                  restricted: item.manifest.piMeme.agent.restricted
                    ? path.join(item.directory, item.manifest.piMeme.agent.restricted)
                    : undefined,
                  restrictedServer: item.manifest.piMeme.server?.restricted
                    ? path.join(item.directory, item.manifest.piMeme.server.restricted)
                    : undefined,
                  grant: item.grant,
                },
              ]
            : [],
        ),
      ),
      descriptors: current.flatMap((group) =>
        group.registrations
          .filter(
            (item) =>
              isEnabled(item.manifest.name) && (!inherited || inherited.get(item.manifest.name) === group.generation),
          )
          .map((item) => this.descriptor(item, group.generation)),
      ),
      handlers,
      callOperation: async (pluginId, operation, input, context) => {
        if (released) throw new Error('scope-expired: 插件租约已释放')
        const group = current.find((g) => g.ids.has(pluginId))
        if (!group || context.pluginId !== pluginId || context.generation !== group.generation)
          throw new Error('generation-mismatch: 插件调用不属于此租约')
        if (
          !context.policyHash ||
          context.policyHash !== group.registrations.find((item) => item.manifest.name === pluginId)?.policyHash
        )
          throw new Error('policy-changed: Agent 调用不属于此代码快照')
        return this.invokeOperation(group, pluginId, operation, input, context)
      },
      runHandler: async (channel, args = []) => {
        if (released) throw new Error('插件租约已释放')
        const handler = handlers[channel]
        if (!handler) throw new Error(`插件租约不包含操作：${channel}`)
        return handler(...args)
      },
      release: async () => {
        if (released) return
        released = true
        const errors: unknown[] = []
        for (const group of current) {
          try {
            await this.release(group)
          } catch (cause) {
            errors.push(cause)
          }
        }
        if (errors.length) throw new AggregateError(errors, '插件租约释放失败')
      },
    }
  }
  async restore() {
    try {
      await this.publish(() => this.loadState(true))
    } catch {
      return
    }
    const entries = [...this.records.values()]
    this.restoring = true
    try {
      await this.track(async () => {
        const next = new Map<string, Registration>()
        for (const entry of entries) {
          if (legacySystemPluginIds.includes(entry.id)) {
            if (entry.builtin !== true) this.records.set(entry.id, entry)
            continue
          }
          if (entry.builtin === true && isReservedPluginId(entry.id)) continue
          try {
            assertExternalPluginId(entry.id)
            const registration = await this.fromDirectory(entry.directory)
            if (registration.manifest.name !== entry.id) throw new Error('安装记录与插件 manifest 身份不匹配')
            registration.enabled = entry.enabled
            registration.sourceDirectory = entry.sourceDirectory
            await this.validateResources(registration)
            next.set(entry.id, registration)
          } catch (cause) {
            this.failures.set(entry.id, { id: entry.id, directory: entry.directory, message: String(cause) })
          }
        }
        const candidates = new Map(next)
        const providers = new Map<string, string[]>()
        for (const item of candidates.values()) {
          if (!item.enabled) continue
          for (const name of item.manifest.piMeme.provides ?? []) {
            const ids = providers.get(name) ?? []
            ids.push(item.manifest.name)
            providers.set(name, ids)
          }
        }
        const fail = (item: Registration, message: string) => {
          this.failures.set(item.manifest.name, { id: item.manifest.name, directory: item.directory, message })
          candidates.delete(item.manifest.name)
        }
        for (const item of [...candidates.values()]) {
          if (!item.enabled) continue
          for (const name of item.manifest.piMeme.provides ?? []) {
            if ((providers.get(name)?.length ?? 0) > 1) {
              fail(item, `服务已有提供者：${name}`)
              break
            }
          }
        }
        let changed = true
        while (changed) {
          changed = false
          for (const item of [...candidates.values()]) {
            if (!item.enabled) continue
            for (const name of item.manifest.piMeme.requires ?? []) {
              if (!(providers.get(name) ?? []).some((id) => candidates.get(id)?.enabled)) {
                fail(item, `${item.manifest.name} 所需服务不可用：${name}`)
                changed = true
                break
              }
            }
          }
        }
        // 整批恢复先确认代次预留，溢出或落盘失败时不执行任何候选代码。
        const reserved = await this.publish(() =>
          this.reserveGenerations([...candidates.values()].filter((item) => item.enabled).length),
        )
        // 分别检查连通组，循环依赖不影响独立组。
        const unchecked = new Set([...candidates.values()].filter((item) => item.enabled))
        while (unchecked.size) {
          const seed = unchecked.values().next().value!
          const members = new Set([seed])
          unchecked.delete(seed)
          let expanded = true
          while (expanded) {
            expanded = false
            for (const item of unchecked) {
              if (
                [...members].some(
                  (member) =>
                    (item.manifest.piMeme.requires ?? []).some((name) =>
                      member.manifest.piMeme.provides?.includes(name),
                    ) ||
                    (member.manifest.piMeme.requires ?? []).some((name) =>
                      item.manifest.piMeme.provides?.includes(name),
                    ),
                )
              ) {
                members.add(item)
                unchecked.delete(item)
                expanded = true
              }
            }
          }
          try {
            const component = this.components(new Map([...members].map((item) => [item.manifest.name, item])))[0]!
            this.groups.add(await this.startGroup(component, reserved.shift()!))
          } catch (cause) {
            for (const item of members) fail(item, String(cause))
          }
        }
        this.registrations = next
        this.changed()
      })
    } catch (cause) {
      if (!this.stateFailure) {
        this.stateFailure = new Error(`插件恢复失败；保留安装记录，本次不加载外部插件：${String(cause)}`)
        this.restoreDiagnostics.push({ message: this.stateFailure.message })
      }
    } finally {
      this.restoring = false
    }
    try {
      await this.publish(async () => {
        if (this.stateFailure) throw this.stateFailure
        await writeInstalledState(this.options.stateFile, installedState(this.generation, [...this.records.values()]))
      })
    } catch (cause) {
      if (!this.stateFailure) {
        this.stateFailure = new Error(`插件清单迁移写入失败；原文件保留，后续变更未接纳：${String(cause)}`)
        this.restoreDiagnostics.push({ message: this.stateFailure.message })
      }
    }
  }
  assertIdle() {
    if (
      this.operations.size ||
      this.pending.size ||
      [...this.groups, ...this.retired].some((group) => group.references)
    )
      throw new Error('插件仍有执行中的操作，请稍后再维护存储')
  }
  async dispose() {
    this.disposed = true
    for (const entry of [...this.uiLeases.values()]) await this.releaseUiLease(entry.owner, entry.lease.id)
    await this.options.drain?.([...this.registrations.keys()])
    await Promise.allSettled([...this.operations])
    while ([...this.groups, ...this.retired].some((group) => group.references))
      await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
    const errors: unknown[] = []
    for (const group of [...this.groups, ...this.retired].reverse()) {
      try {
        await this.disposeGroup(group)
      } catch (cause) {
        errors.push(cause)
      }
    }
    this.groups.clear()
    this.retired.clear()
    this.registrations.clear()
    if (errors.length) throw new AggregateError(errors, '插件管理器释放失败')
  }
}
