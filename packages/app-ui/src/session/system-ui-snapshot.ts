import type { SessionRef } from '@pi-meme/contracts/app-host'
import type { HostService, PlatformAdapter } from '@pi-meme/contracts/host'
import type { SystemClientRequest } from '@pi-meme/contracts/system-tools'
import type { ComposerView } from '@pi-meme/plugin-sdk/composer'
import type { UiPanel } from '@pi-meme/plugin-sdk/ui'
import type { RegisteredNavigation, RegisteredPage } from '@pi-meme/plugin-sdk/navigation'
import type { SshCapabilities, SshConnection } from '@pi-meme/contracts/ssh-connections'
import { clientReadList, systemMetadataUrl } from '@pi-meme/contracts/system-client-reads'
import { readText, SystemReadError } from '@pi-meme/contracts/system-read'
import { SHORTCUT_DEFINITIONS } from '@pi-meme/contracts/keyboard-shortcuts'
import type { ShortcutContextValue } from '../shortcuts/shortcut-provider'
import type { AppRoute } from '../layout/use-app-navigation'
import { panelStorageKey, readPanelLayout, type PanelLayoutState } from '../layout/panel-layout'

export type SystemUiSources = {
  hostId?: string
  session?: SessionRef
  active: boolean
  route: AppRoute
  canBack: boolean
  canForward: boolean
  dirty: boolean
  saving: boolean
  composer: () => ComposerView | null
  panels: readonly UiPanel[]
  panelSnapshot: { sessionId: string; layout: PanelLayoutState } | null
  shortcuts: ShortcutContextValue
  services: readonly HostService[]
  ssh?: { capabilities: () => Promise<SshCapabilities>; list: () => Promise<SshConnection[]> }
  pages: readonly RegisteredPage[]
  navigation: readonly RegisteredNavigation[]
  messageActions: readonly { id: string; pluginId: string; generation: number; title?: string }[]
}
function platform() {
  return (window as Window & { piPlatform?: PlatformAdapter }).piPlatform
}
function routeMetadata(route: AppRoute) {
  switch (route.kind) {
    case 'settings':
      return { kind: route.kind, section: route.section }
    case 'customization':
      return { kind: route.kind, section: route.section }
    case 'plugin':
      return { kind: route.kind, pluginId: route.pluginId, pageId: route.pageId, target: route.target }
    case 'materials':
      return { kind: route.kind, section: route.section }
    case 'schedules':
      return { kind: route.kind, taskId: route.taskId }
    default:
      return { kind: route.kind }
  }
}
function composerSource(source: SystemUiSources, request: SystemClientRequest) {
  const view = source.composer()
  if (!view) throw new SystemReadError('not-loaded', '当前客户端没有可读取的可见输入框')
  const session = view.ref.session
  if (session && (session.hostId !== request.session.hostId || session.sessionId !== request.session.sessionId))
    throw new SystemReadError('permission-denied', '当前输入框不属于执行会话，未切换界面')
  if (view.ref.target.hostId !== request.session.hostId)
    throw new SystemReadError('permission-denied', '当前输入框属于其他 Host')
  return view
}
function sameComposerReference(input: unknown, expected: unknown, depth = 0): boolean {
  if (input === expected) return true
  if (
    depth > 16 ||
    !input ||
    !expected ||
    typeof input !== 'object' ||
    typeof expected !== 'object' ||
    Array.isArray(input) ||
    Array.isArray(expected)
  )
    return false
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) return false
  const value = input as Record<string, unknown>
  const reference = expected as Record<string, unknown>
  const keys = Object.keys(value).filter((key) => value[key] !== undefined || !Object.hasOwn(reference, key))
  const expectedKeys = Object.keys(reference).filter((key) => reference[key] !== undefined)
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => Object.hasOwn(reference, key) && sameComposerReference(value[key], reference[key], depth + 1))
  )
}
function referencedComposer(source: SystemUiSources, request: SystemClientRequest) {
  const view = composerSource(source, request)
  const input = request.args[0] as { ref?: unknown; revision?: unknown; offset?: unknown; limit?: unknown } | undefined
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !['ref', 'revision', 'offset', 'limit'].includes(key))
  )
    throw new SystemReadError('invalid-input', '必须提供明确输入框引用与修订')
  if (!sameComposerReference(input.ref, view.ref) || input.revision !== view.revision)
    throw new SystemReadError('stale-cursor', '输入框引用或草稿修订已过期，请重新读取状态')
  return { view, input }
}
export async function readSystemUiSnapshot(source: SystemUiSources, request: SystemClientRequest): Promise<unknown> {
  const { operation } = request
  if (operation === 'client.state')
    return {
      hostId: source.hostId,
      observedSession: source.session
        ? { hostId: source.session.hostId, sessionId: source.session.sessionId }
        : undefined,
      activeService: source.active,
      navigation: routeMetadata(source.route),
      dirty: source.dirty,
      saving: source.saving,
      platform: platform() ? 'desktop' : 'web',
    }
  if (operation === 'client.navigation')
    return {
      route: routeMetadata(source.route),
      activeService: source.active,
      canBack: source.canBack,
      canForward: source.canForward,
      dirty: source.dirty,
      saving: source.saving,
    }
  if (operation === 'client.panels') {
    const target = (request.args[0] ?? request.session) as SessionRef
    if (
      !target ||
      target.hostId !== request.session.hostId ||
      typeof target.sessionId !== 'string' ||
      target.sessionId !== request.session.sessionId
    )
      throw new SystemReadError('permission-denied', '面板目标必须属于明确执行会话')
    const live = source.panelSnapshot?.sessionId === target.sessionId ? source.panelSnapshot.layout : null
    let saved: PanelLayoutState | null = null
    if (!live) {
      try {
        const raw = localStorage.getItem(panelStorageKey(target.hostId, target.sessionId))
        if (raw) saved = readPanelLayout(raw)
      } catch {
        /* An unavailable archive is distinct from an empty layout. */
      }
    }
    const layout = live ?? saved
    return {
      session: { hostId: target.hostId, sessionId: target.sessionId },
      source: live ? 'live' : saved ? 'saved' : 'unavailable',
      layout,
      panels: source.panels.map(({ id, title, scope, location, generation }) => ({
        id,
        title,
        scope,
        location,
        generation,
      })),
    }
  }
  if (operation === 'composer.status') {
    const view = composerSource(source, request)
    return {
      ref: view.ref,
      revision: view.revision,
      selectionRevision: view.selectionRevision,
      editable: view.editable,
      composing: view.composing,
      canSubmit: view.canSubmit,
      submissionState: view.submissionState,
      attachmentCount: view.attachments.length,
      documentLength: view.document.reduce(
        (total, inline) => total + (inline.kind === 'text' ? inline.text.length : inline.name.length),
        0,
      ),
      hasDraft: view.document.length > 0,
      processorCount: view.processors.length,
      blocked: Boolean(view.disabledReason),
    }
  }
  if (operation.startsWith('composer.')) {
    const { view, input } = referencedComposer(source, request)
    if (operation === 'composer.attachments')
      return {
        ref: view.ref,
        draftRevision: view.revision,
        ...clientReadList(
          view.attachments,
          { offset: input.offset, limit: input.limit },
          `composer.attachments:${view.ref.id}:${view.ref.epoch}:${view.revision}`,
        ),
      }
    if (operation === 'composer.processing')
      return {
        ref: view.ref,
        revision: view.revision,
        status: view.submissionState,
        processors: view.processors,
        failure: view.failure
          ? {
              attemptId: view.failure.attemptId,
              pluginId: view.failure.pluginId,
              hookId: view.failure.hookId,
              title: view.failure.title,
              code: 'processor-blocked',
            }
          : undefined,
      }
    if (operation === 'composer.read') {
      const offset = input.offset ?? 0
      const limit = input.limit ?? 10000
      if (
        !Number.isSafeInteger(offset) ||
        (offset as number) < 0 ||
        !Number.isSafeInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > 20000
      )
        throw new SystemReadError('invalid-input', '草稿分页范围无效；limit 为 1..20000 字符')
      const content = JSON.stringify({ document: view.document, selection: view.selection })
      return {
        ref: view.ref,
        draftRevision: view.revision,
        format: 'application/json',
        ...readText(content, { offset: offset as number, limit: limit as number }),
      }
    }
  }
  if (operation === 'shortcuts.list')
    return {
      platform: source.shortcuts.platform,
      environment: source.shortcuts.environment,
      loading: source.shortcuts.loading,
      items: SHORTCUT_DEFINITIONS.map((definition) => ({
        id: definition.id,
        group: definition.group,
        defaultBinding:
          source.shortcuts.environment === 'web'
            ? (definition.webDefaultBinding ?? definition.defaultBinding)
            : definition.defaultBinding,
        override: source.shortcuts.preferences.overrides[definition.id],
        binding: source.shortcuts.binding(definition.id),
      })),
    }
  if (operation === 'client.connections.list' || operation === 'client.connections.status') {
    if (operation.endsWith('.status') && request.args[0] !== undefined && typeof request.args[0] !== 'string')
      throw new SystemReadError('invalid-input', '服务标识无效')
    const services = source.services.map((service) => ({
      id: service.id,
      hostId: service.hostId,
      name: service.name,
      address: systemMetadataUrl(service.address),
      local: service.local,
      status: service.status,
      transport: service.transport,
      enabled: service.enabled,
      phase: service.phase,
      step: service.step,
      errorCode: service.errorCode,
      nextRetryAt: service.nextRetryAt,
    }))
    if (operation.endsWith('.status') && request.args[0] !== undefined) {
      const service = services.find((service) => service.id === request.args[0])
      if (!service) throw new SystemReadError('not-found', '客户端未登记此服务')
      return { service, source: 'cached', observedAt: new Date().toISOString() }
    }
    return {
      ...clientReadList(services, operation.endsWith('.list') ? request.args[0] : undefined, operation),
      source: 'cached',
      freshness: 'unknown',
    }
  }
  if (operation === 'client.ssh.capabilities') {
    if (!source.ssh) return { canManage: false, available: false, reason: '客户端入口未提供 SSH 连接管理' }
    return source.ssh.capabilities()
  }
  if (operation === 'client.ssh.list') {
    if (!source.ssh || !(await source.ssh.capabilities()).canManage)
      throw new SystemReadError('permission-denied', '客户端入口不允许读取 SSH 配置')
    return {
      items: (await source.ssh.list()).map((item) => ({
        id: item.id,
        name: item.name,
        target: item.target,
        port: item.port,
        hostId: item.hostId,
        enabled: item.enabled,
        phase: item.phase,
        step: item.step,
        errorCode: item.errorCode,
        nextRetryAt: item.nextRetryAt,
        hasIdentityFile: Boolean(item.identityFile),
      })),
    }
  }
  if (operation === 'client.platform.capabilities') {
    const adapter = platform()
    return {
      platform: adapter ? 'desktop' : 'web',
      browser: Boolean(adapter?.browser),
      directoryPicker: Boolean(adapter?.chooseDirectory),
      projectApps: Boolean(adapter?.getProjectApps),
      openPath: Boolean(adapter?.openPath),
      importTheme: Boolean(adapter?.importTheme),
      exportTheme: Boolean(adapter?.exportTheme),
      storage: Boolean(adapter?.storage),
      windowCommands: Boolean(adapter?.titleBar),
      shortcuts: Boolean(adapter?.shortcuts),
      nativeActionsRequireWrite: true,
    }
  }
  if (operation === 'client.projectApps.list') {
    const adapter = platform()
    if (!adapter) throw new SystemReadError('not-supported', '当前客户端不支持本机项目应用目录')
    return { items: (await adapter.getProjectApps()).map(({ id, name }) => ({ id, name })) }
  }
  if (operation === 'client.plugins.ui.list') {
    const items: Array<Record<string, unknown>> = [
      ...source.pages.map(({ id, title, scope, pluginId, generation }) => ({
        kind: 'page',
        id,
        title,
        scope,
        pluginId,
        generation,
      })),
      ...source.panels
        .filter((panel) => !panel.id.startsWith('builtin:'))
        .map(({ id, title, scope, generation }) => ({
          kind: 'panel',
          id,
          title,
          scope,
          pluginId: id.split(':')[0],
          generation,
        })),
      ...source.messageActions.map(({ id, pluginId, generation, title }) => ({
        kind: 'message-action',
        id,
        pluginId,
        generation,
        title,
      })),
    ]
    for (const navigation of source.navigation) {
      const { pluginId, generation, title, defaultPageId } = navigation
      items.push({ kind: 'navigation', pluginId, generation, title, defaultPageId })
      for (const group of navigation.groups)
        for (const item of group.items)
          items.push({
            kind: 'navigation-item',
            pluginId,
            generation,
            groupId: group.id,
            groupTitle: group.title,
            id: item.id,
            pageId: item.pageId,
            title: item.title,
          })
    }
    return clientReadList(items, request.args[0], 'client.plugins.ui.list')
  }
  throw new SystemReadError('not-supported', '客户端读取操作不存在')
}
