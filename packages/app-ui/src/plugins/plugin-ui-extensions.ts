import type { UiTarget } from '@pi-meme/contracts/plugin-ui-data'
import type { RegisteredMessageAction, UiMessageAction, UiMessageActionsApi } from '@pi-meme/plugin-sdk/message-actions'
import type {
  RegisteredNavigation,
  RegisteredPage,
  UiNavigation,
  UiNavigationApi,
  UiPage,
  UiPageRequest,
  UiPagesApi,
} from '@pi-meme/plugin-sdk/navigation'

export type PluginUiExtensionsOptions = {
  pluginId: string
  generation: number
  getTarget: () => UiTarget
  onChanged: () => void
  onPageRequest: (request: Omit<UiPageRequest, 'revision'>) => void
  onBack: () => void
}

export function createPluginUiExtensions(options: PluginUiExtensionsOptions) {
  const pages = new Map<string, RegisteredPage>()
  const actions = new Map<string, RegisteredMessageAction>()
  let navigation: RegisteredNavigation | undefined
  let disposed = false
  const assertActive = () => {
    if (disposed) throw new Error('plugin-retired：插件界面已退役')
  }
  const ownId = (id: string) => {
    if (!id.startsWith(`${options.pluginId}:`) || id.length <= options.pluginId.length + 1)
      throw new Error('插件标识必须使用自身名称作为前缀')
  }
  const pageApi: UiPagesApi = {
    register(page: UiPage) {
      assertActive()
      ownId(page.id)
      if (pages.has(page.id) || !page.title.trim() || typeof page.render !== 'function')
        throw new Error('插件页面标识重复或缺少标题、render')
      if (!['app', 'project', 'session'].includes(page.scope)) throw new Error('插件页面范围无效')
      pages.set(page.id, Object.freeze({ ...page, pluginId: options.pluginId, generation: options.generation }))
      options.onChanged()
      return () => {
        pages.delete(page.id)
        options.onChanged()
      }
    },
  }
  const actionApi: UiMessageActionsApi = {
    register(action: UiMessageAction) {
      assertActive()
      ownId(action.id)
      if (actions.has(action.id) || !action.title.trim() || typeof action.execute !== 'function')
        throw new Error('消息动作标识重复或缺少标题、execute')
      if (
        !Array.isArray(action.match?.roles) ||
        !action.match.roles.length ||
        action.match.roles.some((role) => !['user', 'assistant', 'tool', 'custom'].includes(role)) ||
        !['self', 'any'].includes(action.match.source)
      )
        throw new Error('消息动作必须声明有效角色和来源范围')
      if (
        (action.match.toolName !== undefined && !action.match.toolName.trim()) ||
        (action.match.customType !== undefined && !action.match.customType.trim())
      )
        throw new Error('消息动作类型过滤不能为空')
      actions.set(
        action.id,
        Object.freeze({
          ...action,
          match: Object.freeze({ ...action.match, roles: Object.freeze([...action.match.roles]) }),
          pluginId: options.pluginId,
          generation: options.generation,
        }),
      )
      options.onChanged()
      return () => {
        actions.delete(action.id)
        options.onChanged()
      }
    },
  }
  const navigationApi: UiNavigationApi = {
    register(entry: UiNavigation) {
      assertActive()
      if (navigation) throw new Error('每个插件只能注册一个活动栏入口')
      if (!entry.title.trim()) throw new Error('插件导航标题不能为空')
      const ids = new Set<string>()
      for (const group of entry.groups) {
        if (!group.id.trim() || ids.has(group.id)) throw new Error('插件菜单分组标识为空或重复')
        ids.add(group.id)
        for (const item of group.items) {
          if (!item.id.trim() || ids.has(item.id)) throw new Error('插件菜单项标识为空或重复')
          ids.add(item.id)
          ownId(item.pageId)
        }
      }
      ownId(entry.defaultPageId)
      navigation = Object.freeze({
        ...entry,
        groups: Object.freeze(
          entry.groups.map((group) =>
            Object.freeze({ ...group, items: Object.freeze(group.items.map((item) => Object.freeze({ ...item }))) }),
          ),
        ),
        pluginId: options.pluginId,
        generation: options.generation,
      })
      options.onChanged()
      return () => {
        navigation = undefined
        options.onChanged()
      }
    },
    async openPage(pageId, input) {
      assertActive()
      ownId(pageId)
      const page = pages.get(pageId)
      if (!page) throw new Error('插件页面尚未注册')
      const target = structuredClone(input?.target ?? options.getTarget())
      if (
        target.hostId !== options.getTarget().hostId ||
        (target.project && (target.project.hostId !== target.hostId || !target.project.projectId?.trim())) ||
        (target.session && (target.session.hostId !== target.hostId || !target.session.sessionId?.trim()))
      )
        throw new Error('不能打开其他 Host 的插件页面或无效目标')
      if (!pageAvailable(page, target)) throw new Error('插件页面缺少对应项目或会话目标')
      const params = input?.params ?? null
      assertPageParams(params)
      options.onPageRequest({ pluginId: options.pluginId, pageId, target, params: structuredClone(params) })
    },
    back() {
      assertActive()
      options.onBack()
    },
  }
  return {
    pages: pageApi,
    messageActions: actionApi,
    navigation: navigationApi,
    getPages: () => [...pages.values()],
    getNavigation: () => (navigation ? [navigation] : []),
    getMessageActions: () => [...actions.values()],
    validate() {
      if (!navigation) return
      for (const id of [
        navigation.defaultPageId,
        ...navigation.groups.flatMap((group) => group.items.map((item) => item.pageId)),
      ])
        if (!pages.has(id)) throw new Error(`插件导航引用了未注册页面：${id}`)
    },
    dispose() {
      disposed = true
      pages.clear()
      actions.clear()
      navigation = undefined
      options.onChanged()
    },
  }
}

export function pageAvailable(page: Pick<UiPage, 'scope'>, target: UiTarget): boolean {
  return page.scope === 'app' || Boolean(page.scope === 'project' ? target.project : target.session)
}

export function assertPageParams(value: unknown) {
  const seen = new Set<object>()
  const visit = (item: unknown, depth: number): boolean => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true
    if (typeof item === 'number') return Number.isFinite(item)
    if (typeof item !== 'object' || depth > 32 || seen.has(item)) return false
    const array = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false
    seen.add(item)
    const keys = Reflect.ownKeys(item)
    const valid =
      (!array || keys.length === item.length + 1) &&
      keys.every((key) => {
        if (array && key === 'length') return true
        if (typeof key !== 'string') return false
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        return Boolean(descriptor && 'value' in descriptor && visit(descriptor.value, depth + 1))
      })
    seen.delete(item)
    return valid
  }
  if (!visit(value, 0)) throw new Error('插件页面参数只能包含有限数值和普通 JSON 值，不能包含循环引用')
  const json = JSON.stringify(value)
  if (new TextEncoder().encode(json).byteLength > 16 * 1024) throw new Error('插件页面参数必须是 16 KiB 以内的 JSON')
}
