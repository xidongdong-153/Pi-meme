import type { HostApi } from '@pi-meme/contracts/app-host'
import type { UiReactiveState } from '@pi-meme/contracts/plugin-ui-data'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import { PluginScope } from '@pi-meme/plugin-sdk/scope'
import { isReservedPluginId } from '@pi-meme/plugin-sdk/reserved'
import { createPluginServerClient, type PluginUiLease } from '@pi-meme/plugin-sdk/rpc'
import type { PluginUiCapability } from '@pi-meme/plugin-sdk/permissions'
import type { ComposerAdapter, ComposerApi, RegisteredBeforeSendHook } from '@pi-meme/plugin-sdk/composer'
import type { RegisteredMessageAction } from '@pi-meme/plugin-sdk/message-actions'
import type { RegisteredNavigation, RegisteredPage, UiPageRequest } from '@pi-meme/plugin-sdk/navigation'
import type { UiDataSource, UiExternalStore, UiReactiveApi } from '@pi-meme/plugin-sdk/reactive'
import type { UiContribution, UiPanel, UiPluginDescriptor, UiPluginModule, UiTarget } from '@pi-meme/plugin-sdk/ui'
import { createPluginUiExtensions } from './plugin-ui-extensions'
import { PluginUiDataSource } from './plugin-ui-data-source'
import type { PluginConsentRequest } from './plugin-ui-consent'
import { createPluginActionHost } from './plugin-action-host'

type ActivePlugin = {
  descriptor: UiPluginDescriptor
  scope: PluginScope
  contributions: Map<string, UiContribution>
  panels: Map<string, UiPanel>
  hooks: Map<string, RegisteredBeforeSendHook>
  extensions: ReturnType<typeof createPluginUiExtensions>
  retired: boolean
  controller: AbortController
  host: HostApi
}
type EditingLease = {
  generation: number
  routeInstance: string
  lease?: PluginUiLease
  timer?: ReturnType<typeof setInterval>
  error?: string
}

export function trustedPluginUi(descriptor: UiPluginDescriptor) {
  return Boolean(
    !descriptor.grantChanging &&
    descriptor.policyHash &&
    descriptor.grant?.policyHash === descriptor.policyHash &&
    descriptor.grant.trusted.ui,
  )
}
export function pluginUiGranted(descriptor: UiPluginDescriptor, capability: PluginUiCapability) {
  return (
    trustedPluginUi(descriptor) &&
    Boolean(descriptor.permissions?.ui?.includes(capability) && descriptor.grant?.ui.includes(capability))
  )
}

export function beforeSendHookAvailable(
  hook: RegisteredBeforeSendHook,
  plugin: UiPluginDescriptor | undefined,
  projectPlugin: UiPluginDescriptor | undefined,
) {
  // 项目快照可能仍来自旧 Worker；处理器代次与授权只取当前插件。
  return Boolean(
    plugin?.id === hook.pluginId &&
    plugin.generation === hook.generation &&
    plugin.enabled &&
    plugin.status === 'active' &&
    projectPlugin?.id === hook.pluginId &&
    projectPlugin.enabled &&
    projectPlugin.status === 'active' &&
    pluginUiGranted(plugin, 'composer.before-send') &&
    plugin.permissions?.beforeSend?.includes(hook.id) &&
    plugin.grant?.beforeSend.includes(hook.id),
  )
}

export class UiPluginRegistry {
  private readonly active = new Map<string, ActivePlugin>()
  private readonly listeners = new Set<() => void>()
  private readonly failures = new Map<string, string>()
  private readonly editing = new Map<string, EditingLease>()
  private contributions: UiContribution[] = []
  private panels: UiPanel[] = []
  private pages: RegisteredPage[] = []
  private navigation: RegisteredNavigation[] = []
  private actions: RegisteredMessageAction[] = []
  private hooks: RegisteredBeforeSendHook[] = []
  private panelRequest: { id: string; revision: number; target: UiTarget } | null = null
  private pageRequest: UiPageRequest | null = null
  private requestRevision = 0
  private backRequest = 0
  private version = 0
  private chatVisible = true
  private composer: ComposerAdapter | null = null
  private confirmation: (request: PluginConsentRequest) => Promise<boolean> = async () => false
  private cancelConfirmation: (pluginId?: string) => void = () => {}
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private descriptors: UiPluginDescriptor[] = []
  readonly dataSource: PluginUiDataSource

  constructor(
    private readonly host: HostApi,
    private readonly load: (url: string) => Promise<UiPluginModule> = (url) =>
      import(/* @vite-ignore */ url) as Promise<UiPluginModule>,
    private readonly client?: PluginClient,
  ) {
    this.dataSource = new PluginUiDataSource(host)
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getVersion = () => this.version
  getSnapshot = () => this.contributions
  getPanels = () => this.panels
  getPages = () => this.pages
  getNavigation = () => this.navigation
  getMessageActions = () => this.actions
  getBeforeSendHooks = () => this.hooks
  getPanelRequest = () => this.panelRequest
  getPageRequest = () => this.pageRequest
  getBackRequest = () => this.backRequest
  getReactiveSnapshot = () => this.dataSource.reactive.getSnapshot()
  setComposerController(controller: ComposerAdapter | null) {
    this.composer = controller
  }
  setChatVisible(visible: boolean) {
    this.chatVisible = visible
    if (!visible) this.cancelConfirmation()
  }
  setConfirmation(confirm: (request: PluginConsentRequest) => Promise<boolean>, cancel: (pluginId?: string) => void) {
    this.confirmation = confirm
    this.cancelConfirmation = cancel
  }
  updateTarget(state: UiReactiveState) {
    this.dataSource.setEnvironment(state)
  }
  consumePanelRequest = (revision: number) => {
    if (this.panelRequest?.revision !== revision) return
    this.panelRequest = null
    this.notify()
  }
  consumePageRequest = (revision: number) => {
    if (this.pageRequest?.revision !== revision) return
    this.pageRequest = null
    this.notify()
  }
  errors() {
    return Object.fromEntries(this.failures)
  }
  identity(id: string) {
    const plugin = [...this.active.values()].find((entry) => id.startsWith(`${entry.descriptor.id}:`))
    return plugin ? `${plugin.descriptor.generation}:${plugin.descriptor.ui}` : ''
  }
  hasDirtyPage() {
    return this.editing.size > 0
  }
  getEditingError(pluginId: string) {
    const editing = this.editing.get(pluginId)
    const active = this.active.get(pluginId)
    if (editing && active) {
      try {
        this.assertLive(active)
      } catch (cause) {
        return String(cause)
      }
    }
    return editing?.error ?? (editing && !editing.lease ? '正在取得编辑租约，请稍候。' : undefined)
  }
  getPageHost(page: RegisteredPage, signal?: AbortSignal) {
    const plugin = this.active.get(page.pluginId)
    if (!plugin || plugin.descriptor.generation !== page.generation) return undefined
    const scope = signal ? AbortSignal.any([plugin.controller.signal, signal]) : plugin.controller.signal
    return createPluginActionHost(
      this.host,
      page.pluginId,
      () => {
        if (scope.aborted) throw new Error('cancelled：插件页面已离开')
        this.requireCapability(plugin, 'navigation.pages')
        if (this.active.get(page.pluginId) !== plugin) throw new Error('plugin-retired：插件页面已退役')
        const reason = this.getEditingError(page.pluginId)
        if (reason) throw new Error(reason)
      },
      (request) => this.confirmation(request),
      scope,
    )
  }
  getMessageActionContext(action: RegisteredMessageAction, signal?: AbortSignal) {
    const plugin = this.active.get(action.pluginId)
    if (
      !plugin ||
      plugin.descriptor.generation !== action.generation ||
      !pluginUiGranted(plugin.descriptor, 'messages.actions') ||
      !pluginUiGranted(plugin.descriptor, 'messages.read')
    )
      return undefined
    const scope = signal ? AbortSignal.any([plugin.controller.signal, signal]) : plugin.controller.signal
    const assertActive = () => {
      if (scope.aborted) throw new Error('cancelled：消息操作作用域已结束')
      this.requireCapability(plugin, 'messages.actions')
      this.requireCapability(plugin, 'messages.read')
      if (this.active.get(action.pluginId) !== plugin) throw new Error('plugin-retired：消息操作已退役')
    }
    return {
      host: createPluginActionHost(
        this.host,
        action.pluginId,
        assertActive,
        (request) => this.confirmation(request),
        scope,
      ),
      messages: this.messages(plugin),
      signal: scope,
    }
  }

  async setPageDirty(pluginId: string, generation: number, routeInstance: string, dirty: boolean) {
    const existing = this.editing.get(pluginId)
    if (!dirty) {
      if (existing?.routeInstance !== routeInstance) return
      this.editing.delete(pluginId)
      clearInterval(existing.timer)
      if (existing.lease) await this.client?.releaseUiLease(existing.lease.id)
      this.notify()
      void this.synchronize(this.descriptors)
      return
    }
    if (existing?.routeInstance === routeInstance && existing.generation === generation) return
    const plugin = this.active.get(pluginId)
    if (!plugin || plugin.descriptor.generation !== generation || !this.client)
      throw new Error('plugin-retired：插件页面的执行代次已失效')
    if (existing) throw new Error('已有其他未保存的插件页面')
    const marker: EditingLease = { generation, routeInstance }
    this.editing.set(pluginId, marker)
    this.notify()
    try {
      const lease = await this.client.acquireUiLease({ pluginId, generation, routeInstance })
      if (this.editing.get(pluginId) !== marker) {
        await this.client.releaseUiLease(lease.id)
        return
      }
      marker.lease = lease
      this.notify()
      marker.timer = setInterval(() => {
        void this.client!.renewUiLease(lease.id)
          .then((renewed) => {
            if (this.editing.get(pluginId) === marker && renewed) marker.lease = renewed
          })
          .catch((cause) => {
            clearInterval(marker.timer)
            marker.lease = undefined
            marker.error = '编辑租约已过期，请保留页面内容后重新加载。'
            this.failures.set(pluginId, `编辑租约已过期，请保留页面内容后重新加载：${String(cause)}`)
            this.notify()
          })
      }, 15_000)
    } catch (cause) {
      this.editing.delete(pluginId)
      this.notify()
      throw cause
    }
  }

  private notify() {
    this.version++
    for (const listener of this.listeners) listener()
  }
  private changed() {
    const plugins = [...this.active.values()]
    this.contributions = plugins
      .flatMap((plugin) => [...plugin.contributions.values()])
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
    this.panels = plugins.flatMap((plugin) => [...plugin.panels.values()])
    this.pages = plugins
      .filter((plugin) => pluginUiGranted(plugin.descriptor, 'navigation.pages'))
      .flatMap((plugin) => plugin.extensions.getPages())
    this.navigation = plugins
      .filter((plugin) => pluginUiGranted(plugin.descriptor, 'navigation.pages'))
      .flatMap((plugin) => plugin.extensions.getNavigation())
    this.actions = plugins
      .filter((plugin) => pluginUiGranted(plugin.descriptor, 'messages.actions'))
      .flatMap((plugin) => plugin.extensions.getMessageActions())
    this.hooks = plugins.flatMap((plugin) => [...plugin.hooks.values()])
    this.notify()
  }
  private assertLive(plugin: ActivePlugin) {
    const current = this.descriptors.find((entry) => entry.id === plugin.descriptor.id)
    if (plugin.retired || this.closed || !current || !current.enabled) throw new Error('plugin-retired：插件界面已退役')
    if (!trustedPluginUi(current)) throw new Error('permission-denied：插件界面信任已撤销')
    if (current.generation !== plugin.descriptor.generation || current.policyHash !== plugin.descriptor.policyHash) {
      const editing = this.editing.get(plugin.descriptor.id)
      if (
        editing?.lease &&
        editing.generation === plugin.descriptor.generation &&
        editing.lease.expiresAt > Date.now() &&
        current.grant?.revision === plugin.descriptor.grant?.revision
      )
        return plugin.descriptor
      throw new Error('plugin-retired：插件界面已退役')
    }
    return current
  }
  private requireCapability(plugin: ActivePlugin, capability: PluginUiCapability, declarationOnly = false) {
    const current = this.assertLive(plugin)
    if (!current.permissions?.ui?.includes(capability) || (!declarationOnly && !pluginUiGranted(current, capability)))
      throw new Error(`permission-denied：插件未获准使用 ${capability}`)
  }
  private scopedStore<T>(
    plugin: ActivePlugin,
    store: UiExternalStore<T>,
    capability: PluginUiCapability,
  ): UiExternalStore<T> {
    return {
      getSnapshot: () => {
        this.requireCapability(plugin, capability)
        return store.getSnapshot()
      },
      subscribe: (listener) => {
        this.requireCapability(plugin, capability)
        return plugin.scope.own(
          store.subscribe(() => {
            if (!plugin.retired) listener()
          }),
        )
      },
    }
  }
  private reactive(plugin: ActivePlugin): UiReactiveApi {
    const source = this.dataSource.reactive
    return {
      ...this.scopedStore(plugin, source, 'reactive.read'),
      metadata: this.scopedStore(plugin, source.metadata, 'reactive.read'),
      select: (selector, equal) => this.scopedStore(plugin, source.select(selector, equal), 'reactive.read'),
      message: (id) => this.scopedStore(plugin, source.message(id), 'reactive.read'),
      body: (id) => this.scopedStore(plugin, source.body(id), 'messages.read'),
    }
  }
  private messages(plugin: ActivePlugin): UiDataSource['messages'] {
    return {
      page: async (session, input) => {
        this.requireCapability(plugin, 'messages.read')
        const result = await this.dataSource.messages.page(session, input)
        this.requireCapability(plugin, 'messages.read')
        return result
      },
      getMessage: async (ref) => {
        this.requireCapability(plugin, 'messages.read')
        const result = await this.dataSource.messages.getMessage(ref)
        this.requireCapability(plugin, 'messages.read')
        return result
      },
      body: (ref) => this.scopedStore(plugin, this.dataSource.messages.body(ref), 'messages.read'),
    }
  }
  private composerApi(plugin: ActivePlugin): ComposerApi {
    const controller = (capability: PluginUiCapability) => {
      this.requireCapability(plugin, capability)
      if (!this.composer || !this.chatVisible) throw new Error('stale-composer：当前页面没有可见输入框')
      return this.composer
    }
    return {
      current: () => {
        this.requireCapability(plugin, 'composer.read')
        return this.chatVisible ? (this.composer?.current() ?? null) : null
      },
      getSnapshot: (ref) => {
        this.requireCapability(plugin, 'composer.read')
        return this.chatVisible ? (this.composer?.getSnapshot(ref) ?? null) : null
      },
      subscribe: (ref, listener) => plugin.scope.own(controller('composer.read').subscribe(ref, listener)),
      apply: async (ref, input) => {
        const adapter = controller('composer.write')
        const snapshot = adapter.getSnapshot(ref)
        if (!snapshot || snapshot.revision !== input.expectedRevision)
          return { status: 'rejected', code: 'stale-draft', reason: '草稿已变化，请重新读取' }
        const length = snapshot.document.reduce((size, item) => size + (item.kind === 'text' ? item.text.length : 1), 0)
        if (length && input.steps.some((step) => step.kind === 'replace' && step.from === 0 && step.to >= length)) {
          const accepted = await this.confirmation({
            pluginId: plugin.descriptor.id,
            title: '替换当前草稿？',
            description: '插件请求替换非空草稿。确认后仍会检查草稿是否发生变化。',
          })
          if (!accepted) return { status: 'rejected', code: 'cancelled', reason: '已取消替换草稿' }
        }
        return controller('composer.write').apply(ref, input)
      },
      focus: (ref, selection) => controller('composer.write').focus(ref, selection),
      addAttachments: (ref, files, options) =>
        controller('composer.attachments').addAttachments(ref, files, {
          signal: options?.signal
            ? AbortSignal.any([plugin.controller.signal, options.signal])
            : plugin.controller.signal,
        }),
      cancelAttachment: (ref, id) => controller('composer.attachments').cancelAttachment(ref, id),
      selectAgentPlugin: async (ref, id) => {
        controller('composer.write')
        const accepted = await this.confirmation({
          pluginId: plugin.descriptor.id,
          title: '选择当前会话的 Agent 插件？',
          description: `将 ${id} 加入当前聊天的插件选择。这不会提高任务权限。`,
        })
        if (!accepted) return { status: 'rejected', code: 'cancelled', reason: '用户取消了插件选择' }
        return controller('composer.write').selectAgentPlugin(ref, id)
      },
      removeAgentPlugin: async (ref, id) => {
        controller('composer.write')
        const accepted = await this.confirmation({
          pluginId: plugin.descriptor.id,
          title: '取消当前会话的 Agent 插件？',
          description: `从当前聊天移除 ${id}。`,
        })
        if (!accepted) return { status: 'rejected', code: 'cancelled', reason: '用户取消了插件移除' }
        return controller('composer.write').removeAgentPlugin(ref, id)
      },
      submit: async (ref, input) => {
        const snapshot = controller('composer.submit').getSnapshot(ref)
        if (!snapshot || snapshot.revision !== input.expectedRevision)
          return { status: 'blocked', code: 'stale-draft', reason: '草稿已变化，请重新读取' }
        const accepted = await this.confirmation({
          pluginId: plugin.descriptor.id,
          title: '允许插件发送当前草稿？',
          description: `目标：${ref.session?.sessionId ?? '当前新聊天'}\n${snapshot.document
            .map((item) => (item.kind === 'text' ? item.text : `[${item.name}]`))
            .join('')
            .slice(0, 1200)}`,
        })
        if (!accepted) return { status: 'cancelled', reason: '用户取消了发送' }
        return controller('composer.submit').submit(ref, input)
      },
      beforeSend: {
        register: (hook) => {
          this.requireCapability(plugin, 'composer.before-send', true)
          if (
            !/^[a-zA-Z][\w.-]*$/.test(hook.id) ||
            plugin.hooks.has(hook.id) ||
            !hook.title.trim() ||
            typeof hook.process !== 'function'
          )
            throw new Error('发送前处理器的局部标识、标题或 process 无效')
          if (!plugin.descriptor.permissions?.beforeSend?.includes(hook.id))
            throw new Error('发送前处理器必须在 manifest 中声明')
          plugin.hooks.set(hook.id, {
            ...hook,
            pluginId: plugin.descriptor.id,
            generation: plugin.descriptor.generation,
          })
          if (this.active.get(plugin.descriptor.id) === plugin) this.changed()
          return plugin.scope.own(() => {
            plugin.hooks.delete(hook.id)
            if (this.active.get(plugin.descriptor.id) === plugin) this.changed()
          })
        },
      },
    }
  }

  synchronize(descriptors: UiPluginDescriptor[]) {
    this.descriptors = descriptors
    const work = this.tail
      .catch(() => {})
      .then(async () => {
        if (this.closed) return
        const external = descriptors.filter((descriptor) => !isReservedPluginId(descriptor.id))
        const wanted = new Set(
          external
            .filter(
              (plugin) =>
                plugin.enabled &&
                plugin.ui &&
                trustedPluginUi(plugin) &&
                (plugin.status === 'active' || (plugin.status === 'pending' && this.active.has(plugin.id))),
            )
            .map((plugin) => plugin.id),
        )
        for (const [id, plugin] of this.active) {
          if (wanted.has(id)) continue
          this.active.delete(id)
          await this.retire(plugin)
          this.changed()
        }
        for (const descriptor of external) {
          if (!descriptor.enabled || !descriptor.ui || !trustedPluginUi(descriptor) || descriptor.status !== 'active')
            continue
          const previous = this.active.get(descriptor.id)
          if (
            previous?.descriptor.generation === descriptor.generation &&
            previous.descriptor.version === descriptor.version &&
            previous.descriptor.ui === descriptor.ui
          ) {
            previous.descriptor = descriptor
            this.changed()
            continue
          }
          if (
            previous &&
            this.editing.has(descriptor.id) &&
            previous.descriptor.grant?.revision === descriptor.grant?.revision
          )
            continue
          const scope = new PluginScope()
          const controller = new AbortController()
          const candidate: ActivePlugin = {
            descriptor,
            scope,
            contributions: new Map(),
            panels: new Map(),
            hooks: new Map(),
            retired: false,
            controller,
            host: createPluginActionHost(
              this.host,
              descriptor.id,
              () => {
                this.assertLive(candidate)
              },
              (request) => this.confirmation(request),
              controller.signal,
            ),
            extensions: createPluginUiExtensions({
              pluginId: descriptor.id,
              generation: descriptor.generation,
              getTarget: () => this.dataSource.reactive.getSnapshot().target,
              onChanged: () => {
                if (this.active.get(descriptor.id) === candidate) this.changed()
              },
              onPageRequest: (request) => {
                this.requireCapability(candidate, 'navigation.pages')
                if (this.active.get(descriptor.id) !== candidate) throw new Error('plugin-retired：插件尚未激活')
                this.pageRequest = { ...request, revision: ++this.requestRevision }
                this.notify()
              },
              onBack: () => {
                this.requireCapability(candidate, 'navigation.pages')
                this.backRequest++
                this.notify()
              },
            }),
          }
          scope.own(() => candidate.extensions.dispose())
          scope.own(() => candidate.controller.abort())
          const validateId = (id: string) => {
            if (!id.startsWith(`${descriptor.id}:`) || id.length <= descriptor.id.length + 1)
              throw new Error('插件标识必须使用插件名称作为前缀')
            if (candidate.panels.has(id) || candidate.contributions.has(id)) throw new Error(`插件标识重复：${id}`)
          }
          const extension = candidate.extensions
          try {
            const module = await this.load(descriptor.ui)
            if (typeof module.activate !== 'function') throw new Error('插件 UI 入口必须导出 activate(context)')
            const dispose = await module.activate({
              pluginId: descriptor.id,
              generation: descriptor.generation,
              iconUrl: descriptor.iconUrl,
              host: candidate.host,
              server: createPluginServerClient({
                pluginId: descriptor.id,
                generation: descriptor.generation,
                policyHash: descriptor.policyHash,
                leaseId: () => this.editing.get(descriptor.id)?.lease?.id,
                invoke: async (request, signal) => {
                  this.assertLive(candidate)
                  if (this.active.get(descriptor.id) !== candidate || !this.client)
                    throw new Error('plugin-retired：插件通信上下文已失效')
                  const editing = this.editing.get(descriptor.id)
                  if (editing && !editing.lease) throw new Error('scope-expired：编辑租约不可用，请保留草稿并重新加载')
                  const captured = structuredClone(request)
                  const combined = signal
                    ? AbortSignal.any([candidate.controller.signal, signal])
                    : candidate.controller.signal
                  if (combined.aborted) throw new Error('cancelled：插件调用已取消')
                  const operation = this.assertLive(candidate).operations?.find(
                    (entry) => entry.name === captured.operation && entry.audience.includes('ui'),
                  )
                  if (operation?.effect !== 'read') {
                    const accepted = await this.confirmation({
                      pluginId: descriptor.id,
                      title: '允许插件调用后台操作？',
                      description: `${captured.operation}\n目标：${JSON.stringify(captured.target ?? { hostId: this.getReactiveSnapshot().target.hostId })}\n${JSON.stringify(captured.input).slice(0, 1200)}`,
                      signal: combined,
                    })
                    if (!accepted) throw new Error('cancelled：用户取消了插件后台操作')
                    this.assertLive(candidate)
                  }
                  if (combined.aborted) throw new Error('cancelled：插件调用已取消')
                  const result = await this.client.callOperation(captured, combined)
                  this.assertLive(candidate)
                  if (this.active.get(descriptor.id) !== candidate)
                    throw new Error('plugin-retired：插件调用结果来自旧代次')
                  return result
                },
              }),
              composer: this.composerApi(candidate),
              reactive: this.reactive(candidate),
              messages: this.messages(candidate),
              pages: {
                register: (page) => {
                  this.requireCapability(candidate, 'navigation.pages', true)
                  return scope.own(extension.pages.register(page))
                },
              },
              navigation: {
                register: (entry) => {
                  this.requireCapability(candidate, 'navigation.pages', true)
                  return scope.own(extension.navigation.register(entry))
                },
                openPage: extension.navigation.openPage,
                back: extension.navigation.back,
              },
              messageActions: {
                register: (action) => {
                  this.requireCapability(candidate, 'messages.actions', true)
                  return scope.own(extension.messageActions.register(action))
                },
              },
              panels: {
                open: (id) => {
                  this.assertLive(candidate)
                  if (!this.chatVisible) throw new Error('not-chat-view：请先返回聊天再打开右侧面板')
                  if (!id.startsWith(`${descriptor.id}:`) || !candidate.panels.has(id))
                    throw new Error('只能打开自身已注册的面板')
                  this.panelRequest = {
                    id,
                    revision: ++this.requestRevision,
                    target: structuredClone(this.getReactiveSnapshot().target),
                  }
                  this.notify()
                },
                register: (panel) => {
                  this.assertLive(candidate)
                  validateId(panel.id)
                  if (panel.location !== 'right') throw new Error('插件面板位置无效，只能注册到聊天右侧栏')
                  if (!['app', 'project', 'session'].includes(panel.scope)) throw new Error('插件面板范围无效')
                  if (!panel.title.trim() || typeof panel.render !== 'function')
                    throw new Error('插件面板必须提供标题和 render(props)')
                  candidate.panels.set(panel.id, {
                    ...panel,
                    generation: descriptor.generation,
                    render: (props) => panel.render({ ...props, host: candidate.host }),
                  })
                  if (this.active.get(descriptor.id) === candidate) this.changed()
                  return scope.own(() => {
                    candidate.panels.delete(panel.id)
                    if (this.active.get(descriptor.id) === candidate) this.changed()
                  })
                },
              },
              contributions: {
                register: (contribution) => {
                  this.assertLive(candidate)
                  validateId(contribution.id)
                  if (
                    !['composer', 'composer-actions', 'tool-card', 'status', 'settings', 'message'].includes(
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
                  candidate.contributions.set(contribution.id, {
                    ...contribution,
                    generation: descriptor.generation,
                    policyHash: descriptor.policyHash,
                    match: matchField ? { ...contribution.match, ownerId: descriptor.id } : contribution.match,
                    render: (props) => contribution.render({ ...props, host: candidate.host }),
                  })
                  if (this.active.get(descriptor.id) === candidate) this.changed()
                  return scope.own(() => {
                    candidate.contributions.delete(contribution.id)
                    if (this.active.get(descriptor.id) === candidate) this.changed()
                  })
                },
              },
            })
            if (dispose) scope.own(dispose)
            extension.validate()
            const ids = [
              ...candidate.panels.keys(),
              ...candidate.contributions.keys(),
              ...extension.getPages().map((page) => page.id),
              ...extension.getMessageActions().map((action) => action.id),
            ]
            if (new Set(ids).size !== ids.length) throw new Error('插件注册标识重复')
            if (this.closed) {
              candidate.retired = true
              await scope.dispose()
              continue
            }
            candidate.descriptor = this.assertLive(candidate)
            this.active.set(descriptor.id, candidate)
            this.failures.delete(descriptor.id)
            this.changed()
            if (previous) await this.retire(previous)
          } catch (cause) {
            this.failures.set(descriptor.id, `插件 UI 加载失败：${String(cause)}`)
            candidate.retired = true
            await scope
              .dispose()
              .catch((disposeError: unknown) =>
                this.failures.set(descriptor.id, `${String(cause)}；释放失败：${String(disposeError)}`),
              )
            this.changed()
          }
        }
      })
    this.tail = work
    return work
  }

  private async retire(plugin: ActivePlugin) {
    plugin.retired = true
    plugin.controller.abort()
    this.cancelConfirmation(plugin.descriptor.id)
    const editing = this.editing.get(plugin.descriptor.id)
    if (editing) {
      this.editing.delete(plugin.descriptor.id)
      clearInterval(editing.timer)
      if (editing.lease) await this.client?.releaseUiLease(editing.lease.id).catch(() => {})
    }
    await plugin.scope
      .dispose()
      .catch((cause: unknown) => this.failures.set(plugin.descriptor.id, `插件释放失败：${String(cause)}`))
  }
  async dispose() {
    this.closed = true
    this.cancelConfirmation()
    await this.tail.catch(() => {})
    for (const plugin of [...this.active.values()].reverse()) await this.retire(plugin)
    this.active.clear()
    this.dataSource.dispose()
    this.changed()
    this.listeners.clear()
  }
}
