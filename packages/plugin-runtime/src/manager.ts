import { mkdir, mkdtemp, readFile, rename, rm, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { createFacetHost, defineFacet, defineService, type Facet, type FacetHost } from '@earendil-works/chord'
import {
  createFacetBundleArtifactLoader,
  readFacetBundleArtifact,
  type FacetBundleArtifact,
} from '@earendil-works/chord/node'
import { parsePluginManifest, type PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { AgentPluginEntry } from '@pi-meme/plugin-sdk/agent'
import type { PluginHandlers, ServerPluginModule } from '@pi-meme/plugin-sdk/server'
import { PluginScope } from '@pi-meme/plugin-sdk/scope'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import { packPlugin, readPluginManifest, unpackPlugin } from './package'

export type PluginDescriptor = UiPluginDescriptor & {
  builtin: boolean
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
}
export type PluginManagerOptions = {
  directory: string
  dataDirectory: string
  services?: Record<string, object>
  drain?: (pluginIds: string[]) => Promise<void>
  onChange?: (plugins: PluginDescriptor[]) => void
}
type Registration = {
  manifest: PluginManifest
  directory: string
  module?: ServerPluginModule
  artifact?: FacetBundleArtifact
  builtin: boolean
  enabled: boolean
  sourceDirectory?: string
}
type Group = {
  ids: Set<string>
  generation: number
  registrations: Registration[]
  handlers: PluginHandlers
  host: FacetHost
  scope: PluginScope
  references: number
  retired: boolean
}
type SavedPlugin = { id: string; directory: string; builtin: boolean; enabled: boolean; sourceDirectory?: string }

export class PluginManager {
  private registrations = new Map<string, Registration>()
  private groups = new Set<Group>()
  private retired = new Set<Group>()
  private pending = new Set<string>()
  private defaults = new Map<string, SavedPlugin>()
  private generation = 0
  private readonly operations = new Set<Promise<unknown>>()
  private publishTail: Promise<unknown> = Promise.resolve()
  private idleWaiters = new Set<() => void>()
  private disposed = false
  private restoring = false
  constructor(private readonly options: PluginManagerOptions) {}

  private track<T>(operation: () => Promise<T>): Promise<T> {
    const next = Promise.resolve().then(() => {
      if (this.disposed) throw new Error('插件管理器已关闭')
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
    return {
      id: manifest.name,
      version: manifest.version,
      description: manifest.description,
      generation: active,
      directory,
      builtin: registration.builtin,
      enabled,
      status: this.pending.has(manifest.name) ? 'pending' : enabled ? 'active' : 'disabled',
      ui: manifest.piMeme.ui,
      agent: manifest.piMeme.agent,
      requires: manifest.piMeme.requires ?? [],
      provides: manifest.piMeme.provides ?? [],
    }
  }

  list() {
    return [...this.registrations.values()].map((registration) => this.descriptor(registration))
  }
  getGeneration(id: string, generation: number): PluginDescriptor | undefined {
    const group = [...this.groups, ...this.retired].find((item) => item.generation === generation && item.ids.has(id))
    const registration = group?.registrations.find((item) => item.manifest.name === id)
    return registration && this.descriptor(registration, generation)
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

  private components(registrations: Map<string, Registration>) {
    const active = [...registrations.values()].filter((item) => item.enabled)
    const provider = new Map<string, Registration>()
    for (const item of active) {
      for (const name of item.manifest.piMeme.provides ?? []) {
        if (provider.has(name) || Object.hasOwn(this.options.services ?? {}, name))
          throw new Error(`服务已有提供者：${name}`)
        provider.set(name, item)
      }
    }
    for (const item of active) {
      for (const name of item.manifest.piMeme.requires ?? []) {
        if (!provider.has(name) && !Object.hasOwn(this.options.services ?? {}, name))
          throw new Error(`${item.manifest.name} 所需服务不可用：${name}`)
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

  private async startGroup(registrations: Registration[]): Promise<Group> {
    const scope = new PluginScope()
    const generation = ++this.generation
    const handlers: PluginHandlers = {}
    const facets: Facet[] = []
    const serviceDefinitions = new Map<string, ReturnType<typeof defineService<object>>>()
    const definition = (name: string) => {
      if (!serviceDefinitions.has(name)) serviceDefinitions.set(name, defineService<object>(name, { local: true }))
      return serviceDefinitions.get(name)!
    }
    const hostServices = this.options.services ?? {}
    facets.push(
      defineFacet({
        id: `host-services:${generation}`,
        setup: (env) => {
          for (const [name, service] of Object.entries(hostServices)) env.provide(definition(name), service)
        },
      }),
    )
    try {
      for (const registration of registrations) {
        if (registration.artifact) {
          const loaded = await createFacetBundleArtifactLoader({ artifact: registration.artifact }).load()
          scope.own(() => loaded.dispose())
          facets.push(...loaded.facets)
        }
        const pluginScope = new PluginScope()
        scope.own(() => pluginScope.dispose())
        const dataDirectory = path.join(this.options.dataDirectory, encodeURIComponent(registration.manifest.name))
        await mkdir(dataDirectory, { recursive: true })
        facets.push(
          defineFacet({
            id: `app:${registration.manifest.name}:${generation}`,
            setup: (env) => {
              const required = new Map<string, object>()
              for (const name of registration.manifest.piMeme.requires ?? [])
                required.set(name, env.use(definition(name)))
              const module =
                registration.module ??
                (registration.artifact
                  ? env.use(
                      defineService<ServerPluginModule>(`pi-meme.plugin.module:${registration.manifest.name}`, {
                        local: true,
                      }),
                    )
                  : undefined)
              const provided = new Map<string, object>()
              for (const name of registration.manifest.piMeme.provides ?? []) {
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
                  const instance = await module.create({
                    pluginId: registration.manifest.name,
                    generation,
                    dataDirectory,
                    services: {
                      require: <T>(name: string) => {
                        if (!required.has(name)) throw new Error(`插件未声明所需服务：${name}`)
                        return required.get(name) as T
                      },
                    },
                    registerHandlers: (values) => {
                      for (const [channel, handler] of Object.entries(values)) {
                        if (!registration.builtin && !channel.startsWith(`${registration.manifest.name}:`))
                          throw new Error(`插件操作必须使用 ${registration.manifest.name}: 前缀`)
                        const outside = [...this.groups].some(
                          (group) =>
                            !registrations.some((item) => group.ids.has(item.manifest.name)) && group.handlers[channel],
                        )
                        if (typeof handler !== 'function' || Object.hasOwn(handlers, channel) || outside)
                          throw new Error(`插件操作无效或重复：${channel}`)
                        handlers[channel] = handler
                      }
                      return pluginScope.own(() => {
                        for (const key of Object.keys(values)) delete handlers[key]
                      })
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
                for (const name of registration.manifest.piMeme.provides ?? []) {
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

  private async writeState(registrations: Map<string, Registration>) {
    if (this.restoring) return
    await mkdir(this.options.directory, { recursive: true })
    const records = new Map(this.defaults)
    for (const item of registrations.values())
      records.set(item.manifest.name, {
        id: item.manifest.name,
        directory: item.directory,
        enabled: item.enabled,
        builtin: item.builtin,
        sourceDirectory: item.sourceDirectory,
      })
    const state = [...records.values()]
    const temporary = path.join(this.options.directory, `installed-${Date.now()}-${this.generation}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx' })
      await rename(temporary, path.join(this.options.directory, 'installed.json'))
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private async transition(next: Map<string, Registration>, changedIds: string[]) {
    const components = this.components(next)
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
    ].some((item) => item.manifest.piMeme.server)
    try {
      if (hasServer) {
        if (oldGroups.some((group) => group.references)) await this.options.drain?.([...affected])
        while (oldGroups.some((group) => group.references))
          await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
      }
      await this.publish(async () => {
        const previous = this.registrations
        const merged = new Map(previous)
        for (const id of changedIds) {
          const registration = next.get(id)
          if (registration) merged.set(id, registration)
          else merged.delete(id)
        }
        const targetComponents = this.components(merged).filter((items) =>
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
          for (const component of targetComponents) newGroups.push(await this.startGroup(component))
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
          await this.pruneDirectories(
            oldGroups.filter((group) => !this.retired.has(group)).flatMap((group) => group.registrations),
          ).catch(() => {})
        } catch (cause) {
          const errors: unknown[] = [cause]
          for (const group of newGroups) await this.disposeGroup(group).catch((error: unknown) => errors.push(error))
          for (const group of stopped) {
            try {
              this.groups.add(await this.startGroup(group.registrations))
            } catch (error) {
              errors.push(error)
            }
          }
          if (persisted) await this.writeState(previous).catch((error: unknown) => errors.push(error))
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
    const manifest = await readPluginManifest(directory)
    const artifact = manifest.piMeme.server
      ? await readFacetBundleArtifact({ manifestPath: path.join(directory, manifest.piMeme.server), entry: 'server' })
      : undefined
    if (
      artifact &&
      (artifact.plugin.id !== manifest.name ||
        (artifact.plugin.version && artifact.plugin.version !== manifest.version))
    )
      throw new Error('Chord 构建产物与插件身份或版本不匹配')
    return { manifest, directory: path.resolve(directory), artifact, builtin: false, enabled: true }
  }

  private async replace(registration: Registration) {
    const next = new Map(this.registrations)
    next.set(registration.manifest.name, registration)
    await this.transition(next, [registration.manifest.name])
    return this.descriptor(registration)
  }

  private async snapshotDirectory(directory: string) {
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
      const previous = this.registrations.get(id)
      if (!previous) throw new Error('插件不存在')
      const registration =
        previous.sourceDirectory && !previous.builtin
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
  registerBuiltin(manifest: PluginManifest, module: ServerPluginModule, directory: string) {
    return this.track(async () => {
      const checked = parsePluginManifest(manifest)
      let snapshot = directory
      const packaged = await stat(path.join(directory, 'package.json'))
        .then(() => true)
        .catch((cause: unknown) => {
          if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw cause
        })
      if (packaged) {
        const buffer = await packPlugin(directory)
        await mkdir(this.options.directory, { recursive: true })
        snapshot = await mkdtemp(path.join(this.options.directory, 'builtin-'))
        await unpackPlugin(buffer, snapshot)
      }
      try {
        return await this.replace({
          manifest: checked,
          module,
          directory: snapshot,
          builtin: true,
          enabled: this.defaults.get(manifest.name)?.enabled ?? true,
        })
      } catch (cause) {
        if (
          snapshot !== directory &&
          ![...this.groups, ...this.retired].some((group) =>
            group.registrations.some((item) => item.directory === snapshot),
          )
        )
          await rm(snapshot, { recursive: true, force: true })
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
      const current = this.registrations.get(id)
      if (!current) throw new Error('插件不存在')
      const next = new Map(this.registrations)
      const registration = { ...current, enabled }
      next.set(id, registration)
      await this.transition(next, [id])
      return this.descriptor(registration)
    })
  }
  remove(id: string) {
    return this.track(async () => {
      if (!this.registrations.has(id)) throw new Error('插件不存在')
      const registration = this.registrations.get(id)!
      const next = new Map(this.registrations)
      next.delete(id)
      this.components(next)
      const previousDefault = this.defaults.get(id)
      if (registration.builtin)
        this.defaults.set(id, { id, directory: registration.directory, enabled: false, builtin: true })
      try {
        await this.transition(next, [id])
      } catch (cause) {
        if (previousDefault) this.defaults.set(id, previousDefault)
        else this.defaults.delete(id)
        throw cause
      }
    })
  }
  acquire(): PluginLease {
    if (this.disposed) throw new Error('插件管理器已关闭')
    const current = [...this.groups].filter((group) => group.registrations.some((item) => item.manifest.piMeme.agent))
    if (current.some((group) => [...group.ids].some((id) => this.pending.has(id))))
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
          item.manifest.piMeme.agent
            ? [
                {
                  pluginId: item.manifest.name,
                  generation: group.generation,
                  path: path.join(item.directory, item.manifest.piMeme.agent),
                },
              ]
            : [],
        ),
      ),
      descriptors: current.flatMap((group) =>
        group.registrations.map((item) => this.descriptor(item, group.generation)),
      ),
      handlers,
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
  async restore(registerBuiltins?: () => Promise<void>) {
    let entries: SavedPlugin[]
    try {
      entries = JSON.parse(await readFile(path.join(this.options.directory, 'installed.json'), 'utf8'))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        await registerBuiltins?.()
        return
      }
      throw cause
    }
    if (!Array.isArray(entries)) throw new Error('已安装插件清单无效')
    for (const entry of entries) {
      if (typeof entry.id !== 'string' || typeof entry.directory !== 'string' || typeof entry.enabled !== 'boolean')
        throw new Error('已安装插件记录无效')
      if (entry.builtin) this.defaults.set(entry.id, entry)
    }
    this.restoring = true
    try {
      await registerBuiltins?.()
      await this.track(async () => {
        const next = new Map(this.registrations)
        for (const entry of entries) {
          if (entry.builtin) continue
          const registration = await this.fromDirectory(entry.directory)
          registration.enabled = entry.enabled
          registration.sourceDirectory = entry.sourceDirectory
          next.set(registration.manifest.name, registration)
        }
        await this.transition(next, [...next.keys()])
      })
    } finally {
      this.restoring = false
    }
    await this.writeState(this.registrations)
  }
  async dispose() {
    this.disposed = true
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
