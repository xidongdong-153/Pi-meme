import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import { PluginScope } from '@pi-meme/plugin-sdk/scope'
import type { UiContribution, UiPluginDescriptor, UiPluginModule } from '@pi-meme/plugin-sdk/ui'

type ActivePlugin = { descriptor: UiPluginDescriptor; scope: PluginScope; contributions: Map<string, UiContribution> }

export class UiPluginRegistry {
  private readonly active = new Map<string, ActivePlugin>()
  private readonly listeners = new Set<() => void>()
  private readonly failures = new Map<string, string>()
  private contributions: UiContribution[] = []
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(
    private readonly bridge: DesktopBridge,
    private readonly load: (url: string) => Promise<UiPluginModule> = (url) =>
      import(/* @vite-ignore */ url) as Promise<UiPluginModule>,
    private readonly call: <T>(method: string, args?: unknown[]) => Promise<T> = async () => {
      throw new Error('当前客户端没有插件通信接口')
    },
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = () => this.contributions
  errors() {
    return Object.fromEntries(this.failures)
  }
  identity(contributionId: string) {
    const plugin = [...this.active.values()].find((entry) => contributionId.startsWith(`${entry.descriptor.id}:`))
    return plugin ? `${plugin.descriptor.generation}:${plugin.descriptor.ui}` : ''
  }

  private changed() {
    this.contributions = [...this.active.values()]
      .flatMap((plugin) => [...plugin.contributions.values()])
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id))
    for (const listener of this.listeners) listener()
  }

  synchronize(descriptors: UiPluginDescriptor[]) {
    const work = this.tail
      .catch(() => {})
      .then(async () => {
        if (this.closed) return
        const wanted = new Set(
          descriptors
            .filter(
              (plugin) =>
                plugin.enabled &&
                plugin.ui &&
                (plugin.status === 'active' || (plugin.status === 'pending' && this.active.has(plugin.id))),
            )
            .map((plugin) => plugin.id),
        )
        for (const [id, plugin] of this.active) {
          if (wanted.has(id)) continue
          this.active.delete(id)
          try {
            await plugin.scope.dispose()
          } catch (cause) {
            this.failures.set(id, `插件释放失败：${String(cause)}`)
          }
          this.changed()
        }
        for (const descriptor of descriptors) {
          if (!descriptor.enabled || !descriptor.ui || descriptor.status !== 'active') continue
          const previous = this.active.get(descriptor.id)
          if (
            previous?.descriptor.generation === descriptor.generation &&
            previous.descriptor.version === descriptor.version &&
            previous.descriptor.ui === descriptor.ui
          )
            continue
          const scope = new PluginScope()
          const contributions = new Map<string, UiContribution>()
          const candidate = { descriptor, scope, contributions }
          try {
            const module = await this.load(descriptor.ui)
            if (typeof module.activate !== 'function') throw new Error('插件 UI 入口必须导出 activate(context)')
            const disposer = await module.activate({
              pluginId: descriptor.id,
              generation: descriptor.generation,
              iconUrl: descriptor.iconUrl,
              bridge: this.bridge,
              call: <T>(method: string, args?: unknown[]): Promise<T> => {
                if (!method.startsWith(`${descriptor.id}:`)) throw new Error('插件操作必须使用插件名称作为前缀')
                return this.call<T>(method, args)
              },
              contribute: (contribution) => {
                if (!contribution.id.startsWith(`${descriptor.id}:`))
                  throw new Error('插件贡献标识必须使用插件名称作为前缀')
                if (contributions.has(contribution.id)) throw new Error(`插件贡献标识重复：${contribution.id}`)
                if (
                  !['page', 'sidebar', 'composer', 'tool-card', 'status', 'settings', 'message'].includes(
                    contribution.slot,
                  )
                )
                  throw new Error('插件贡献位置无效')
                if (typeof contribution.render !== 'function') throw new Error('插件贡献必须提供 render(props)')
                if (contribution.match?.ownerId && contribution.match.ownerId !== descriptor.id)
                  throw new Error('插件贡献不能匹配其他插件来源')
                const matchField =
                  contribution.slot === 'tool-card'
                    ? 'toolName'
                    : contribution.slot === 'message'
                      ? 'customType'
                      : undefined
                if (
                  matchField &&
                  (typeof contribution.match?.[matchField] !== 'string' || !contribution.match[matchField]?.trim())
                )
                  throw new Error(`插件 ${contribution.slot} 贡献必须声明 match.${matchField}`)
                contributions.set(contribution.id, {
                  ...contribution,
                  generation: descriptor.generation,
                  match: matchField ? { ...contribution.match, ownerId: descriptor.id } : contribution.match,
                })
                if (this.active.get(descriptor.id) === candidate) this.changed()
                return scope.own(() => {
                  contributions.delete(contribution.id)
                  if (this.active.get(descriptor.id) === candidate) this.changed()
                })
              },
            })
            if (disposer) scope.own(disposer)
            if (this.closed) {
              await scope.dispose()
              continue
            }
            this.active.set(descriptor.id, candidate)
            this.failures.delete(descriptor.id)
            this.changed()
            if (previous) {
              try {
                await previous.scope.dispose()
              } catch (cause) {
                this.failures.set(descriptor.id, `旧插件 UI 释放失败：${String(cause)}`)
                this.changed()
              }
            }
          } catch (cause) {
            this.failures.set(descriptor.id, `插件 UI 加载失败：${String(cause)}`)
            try {
              await scope.dispose()
            } catch (disposeCause) {
              this.failures.set(descriptor.id, `${String(cause)}；${String(disposeCause)}`)
            }
            this.changed()
          }
        }
      })
    this.tail = work
    return work
  }

  async dispose() {
    this.closed = true
    await this.tail.catch(() => {})
    const errors: unknown[] = []
    for (const plugin of [...this.active.values()].reverse()) {
      try {
        await plugin.scope.dispose()
      } catch (cause) {
        errors.push(cause)
      }
    }
    this.active.clear()
    this.changed()
    this.listeners.clear()
    if (errors.length) throw new AggregateError(errors, '插件 UI 资源释放失败')
  }
}
