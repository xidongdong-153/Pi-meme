import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { UiJsonValue, UiTarget } from '@pi-meme/contracts/plugin-ui-data'
import { freezeUiValue } from '@pi-meme/contracts/plugin-ui-data'
import type { RegisteredNavigation, RegisteredPage } from '@pi-meme/plugin-sdk/navigation'
import { ErrorBoundary } from '@pi-meme/ui/components/error-boundary'
import { cn } from '@pi-meme/ui/lib/utils'
import { PageHeader, PageHeaderNavigation } from './page-header'
import type { AppRoute } from './use-app-navigation'
import { assertPageParams, pageAvailable } from '../plugins/plugin-ui-extensions'

export type PluginRoute = Extract<AppRoute, { kind: 'plugin' }>
function storageKey(pluginId: string, target: UiTarget) {
  return `pi-meme:plugin-page:v1:${JSON.stringify([target.hostId, pluginId, target.project?.projectId, target.session?.sessionId])}`
}

export function rememberPluginRoute(route: PluginRoute) {
  try {
    assertPageParams(route.params)
    localStorage.setItem(
      storageKey(route.pluginId, route.target),
      JSON.stringify({ pageId: route.pageId, params: route.params }),
    )
  } catch {
    /* 无本地存储时不阻止导航。 */
  }
}

export function pluginRouteForEntry(
  entry: RegisteredNavigation,
  pages: readonly RegisteredPage[],
  target: UiTarget,
): PluginRoute | null {
  let pageId = entry.defaultPageId
  let params: UiJsonValue = null
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(entry.pluginId, target)) ?? 'null') as {
      pageId?: unknown
      params?: UiJsonValue
    } | null
    if (
      saved &&
      typeof saved.pageId === 'string' &&
      pages.some((page) => page.pluginId === entry.pluginId && page.id === saved.pageId && pageAvailable(page, target))
    ) {
      assertPageParams(saved.params ?? null)
      pageId = saved.pageId
      params = saved.params ?? null
    }
  } catch {
    /* 损坏记录回到声明的默认页。 */
  }
  const page = pages.find((value) => value.pluginId === entry.pluginId && value.id === pageId)
  if (!page || !pageAvailable(page, target)) return null
  return { kind: 'plugin', pluginId: entry.pluginId, pageId, target: structuredClone(target), params }
}

export function PluginWorkspacePage({
  route,
  page,
  navigation,
  pages,
  host,
  nativeWindow,
  rail,
  back,
  forward,
  onOpen,
  onParams,
  onDirty,
  onManage,
  unavailableReason,
}: {
  route: PluginRoute
  page: RegisteredPage
  navigation: RegisteredNavigation
  pages: readonly RegisteredPage[]
  host: (signal: AbortSignal) => HostApi
  nativeWindow: boolean
  rail: ReactNode
  back: { label: string; onClick: () => void; disabled?: boolean }
  forward?: { label: string; onClick: () => void; disabled?: boolean }
  onOpen: (route: PluginRoute) => void
  onParams: (params: UiJsonValue) => void
  onDirty: (dirty: boolean) => void
  onManage: () => void
  unavailableReason?: string
}) {
  return (
    <section
      aria-label={`插件页面：${navigation.title}`}
      data-plugin-workspace
      className="workspace-panes flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-secondary"
    >
      <PageHeader>
        <PageHeaderNavigation nativeWindow={nativeWindow} back={back} forward={forward} />
      </PageHeader>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {rail}
        <div className="content-frame bg-background">
          <aside className="w-44 shrink-0 overflow-y-auto border-r border-border bg-card/40 px-2.5 py-5 sm:w-64">
            <h1 className="px-2.5 text-base font-semibold">{navigation.title}</h1>
            <nav aria-label={`${navigation.title}菜单`} className="mt-5 space-y-5">
              {navigation.groups.map((group) => (
                <section key={group.id}>
                  {group.title && <h2 className="mb-1 px-2.5 text-xs text-muted-foreground">{group.title}</h2>}
                  {group.items.map((item) => {
                    const targetPage = pages.find(
                      (candidate) => candidate.pluginId === route.pluginId && candidate.id === item.pageId,
                    )
                    const available = Boolean(targetPage && pageAvailable(targetPage, route.target))
                    return (
                      <button
                        key={item.id}
                        type="button"
                        disabled={!available}
                        title={!available ? '请先选择对应项目或会话' : undefined}
                        aria-current={route.pageId === item.pageId ? 'page' : undefined}
                        onClick={() => onOpen({ ...route, pageId: item.pageId, params: null })}
                        className={cn(
                          'flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm text-muted-foreground hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40',
                          route.pageId === item.pageId && 'bg-secondary font-medium text-foreground',
                        )}
                      >
                        {item.icon && (
                          <span className="flex size-4 items-center justify-center overflow-hidden [&>svg]:size-4">
                            {item.icon}
                          </span>
                        )}
                        {item.title ?? targetPage?.title ?? item.pageId}
                      </button>
                    )
                  })}
                </section>
              ))}
            </nav>
            <button
              type="button"
              onClick={onManage}
              className="mt-6 px-2.5 text-xs text-muted-foreground hover:text-foreground"
            >
              打开插件管理
            </button>
          </aside>
          <div className="min-w-0 flex-1 overflow-hidden">
            {unavailableReason && (
              <p role="alert" className="border-b border-border px-6 py-2 text-sm text-destructive">
                {unavailableReason}
              </p>
            )}
            <ErrorBoundary
              key={JSON.stringify([
                page.pluginId,
                page.generation,
                page.id,
                route.target.hostId,
                route.target.project?.projectId,
                route.target.session?.sessionId,
              ])}
              fallbackTitle={`插件页面渲染失败：${page.title}`}
            >
              <PageBody
                route={route}
                page={page}
                host={host}
                onParams={onParams}
                onDirty={onDirty}
                disabled={Boolean(unavailableReason)}
              />
            </ErrorBoundary>
          </div>
        </div>
      </div>
    </section>
  )
}

function PageBody({
  route,
  page,
  host,
  onParams,
  onDirty,
  disabled,
}: {
  route: PluginRoute
  page: RegisteredPage
  host: (signal: AbortSignal) => HostApi
  onParams: (params: UiJsonValue) => void
  onDirty: (dirty: boolean) => void
  disabled: boolean
}) {
  const key = JSON.stringify([
    page.pluginId,
    page.generation,
    page.id,
    route.target.hostId,
    route.target.project?.projectId,
    route.target.session?.sessionId,
  ])
  const controller = useMemo(() => new AbortController(), [key])
  const scopedHost = useMemo(() => host(controller.signal), [host, controller])
  const container = useRef<HTMLDivElement>(null)
  // 此实例的释放回调不能被下一目标的 render 覆盖。
  const dirty = useRef(onDirty)
  useEffect(
    () => () => {
      controller.abort()
      dirty.current(false)
    },
    [controller],
  )
  const scrollKey = `${storageKey(page.pluginId, route.target)}:${page.id}:scroll`
  useLayoutEffect(() => {
    const node = container.current
    if (!node) return
    try {
      node.scrollTop = Number(localStorage.getItem(scrollKey)) || 0
    } catch {}
    node.focus()
    return () => {
      try {
        localStorage.setItem(scrollKey, String(node.scrollTop))
      } catch {}
    }
  }, [key, scrollKey])
  useEffect(() => rememberPluginRoute(route), [route])
  return (
    <div
      ref={container}
      tabIndex={-1}
      data-plugin-ui={page.pluginId}
      inert={disabled}
      className="h-full overflow-y-auto p-6 outline-none"
    >
      <PageRender
        page={page}
        host={scopedHost}
        route={route}
        signal={controller.signal}
        onParams={onParams}
        onDirty={onDirty}
      />
    </div>
  )
}

function PageRender({
  page,
  host,
  route,
  signal,
  onParams,
  onDirty,
}: {
  page: RegisteredPage
  host: HostApi
  route: PluginRoute
  signal: AbortSignal
  onParams: (params: UiJsonValue) => void
  onDirty: (dirty: boolean) => void
}) {
  const target = useMemo(() => freezeUiValue(structuredClone(route.target)), [route.target])
  const params = useMemo(() => freezeUiValue(structuredClone(route.params)), [route.params])
  return (
    <>
      {page.render({
        host,
        target,
        signal,
        page: {
          id: page.id,
          params,
          setParams(params) {
            if (!signal.aborted) {
              assertPageParams(params)
              onParams(structuredClone(params))
            }
          },
          setUnsavedChanges(dirty) {
            if (!signal.aborted) onDirty(dirty)
          },
        },
      })}
    </>
  )
}
