import { useCallback, useEffect, useRef, useState } from 'react'
import type { SelectWorkspace } from '@pi-meme/contracts/sessions'
import { buildSidebarModel, sidebarManualOrders } from '@pi-meme/workspace/ui/sidebar/sidebar-model'
import { SessionSearchDialog } from '@pi-meme/workspace/ui/sidebar/session-search-dialog'
import { useSidebarManualOrders, useSidebarPreferences } from '@pi-meme/workspace/ui/sidebar/use-sidebar-preferences'
import { App } from './app'
import { MultiServiceSidebar } from './multi-service-sidebar'
import { RemoteSettings } from './remote-settings'
import { serviceAddress, type ServiceController, type ServiceRegistry } from './service-ui'

export function ServicesApp({
  registry,
  nativeWindow,
  onBootComplete,
}: {
  registry: ServiceRegistry
  nativeWindow: boolean
  onBootComplete?: () => void
}) {
  const [services, setServices] = useState(() => registry.list())
  const [activeId, setActiveId] = useState(registry.localServiceId)
  const [, setRevision] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const {
    preferences,
    loaded: preferencesLoaded,
    error: preferenceError,
    save: savePreferences,
  } = useSidebarPreferences(registry.local.bridge)
  const openSearch = useCallback(() => setSearchOpen(true), [])
  const searchHistory = useCallback(
    (serviceId: string, query: string, paths: string[]) => registry.get(serviceId).bridge.searchSessions(query, paths),
    [registry],
  )
  const controllers = useRef(new Map<string, ServiceController>())
  const navigation = useRef(0)
  const activeRef = useRef(activeId)
  activeRef.current = activeId
  const captureController = useCallback((id: string, controller: ServiceController) => {
    const previous = controllers.current.get(id)
    controllers.current.set(id, controller)
    if (previous?.sessions !== controller.sessions || previous?.connection !== controller.connection)
      setRevision((value) => value + 1)
  }, [])
  useEffect(() => registry.subscribe(() => setServices(registry.list())), [registry])
  useEffect(() => {
    void registry
      .initialize()
      .catch((cause: unknown) => controllers.current.get(registry.localServiceId)?.setError(String(cause)))
  }, [registry])
  const activate = (id: string, work: (controller: ServiceController) => Promise<boolean>) => {
    const source = controllers.current.get(activeRef.current)
    if (source?.workspaceDisabledReason) {
      source.setError(source.workspaceDisabledReason)
      return
    }
    const controller = controllers.current.get(id)
    if (!controller || registry.list().find((service) => service.id === id)?.status !== 'connected') {
      source?.setError('此远程服务未连接，请在设置中重试')
      return
    }
    const transaction = ++navigation.current
    void work(controller)
      .then((changed) => {
        if (changed && transaction === navigation.current) setActiveId(id)
      })
      .catch((cause: unknown) => source?.setError(String(cause)))
  }
  async function changeLocation(id: string, input: SelectWorkspace) {
    const sourceId = activeRef.current
    const source = controllers.current.get(sourceId)
    const target = controllers.current.get(id)
    if (!source || !target || source.workspaceDisabledReason) return false
    const transaction = ++navigation.current
    const sourceKey = source.connection.sessionKey
    const draft = source.captureDraft()
    const changed = await target.selectLocation(input, id === sourceId ? undefined : draft)
    if (!changed || transaction !== navigation.current) return false
    if (id !== sourceId) {
      const latestSource = controllers.current.get(sourceId)
      const current = latestSource?.captureDraft()
      if (
        latestSource &&
        latestSource.connection.sessionKey === sourceKey &&
        current &&
        current.mode === draft.mode &&
        current.composer.draft === draft.composer.draft &&
        current.composer.attachments === draft.composer.attachments &&
        current.composer.selectedSkills === draft.composer.selectedSkills
      )
        latestSource.clearDraft()
    }
    setActiveId(id)
    return true
  }
  async function remove(id: string) {
    navigation.current++
    await registry.remove(id)
    controllers.current.delete(id)
    if (activeRef.current === id) setActiveId(registry.localServiceId)
  }
  const model = buildSidebarModel(
    services.map((service) => ({
      serviceId: service.id,
      snapshot: controllers.current.get(service.id)?.sessions ??
        service.sessions ?? {
          pinnedPaths: [],
          recents: [],
          projects: service.projects.map((project) => ({
            ...project,
            sessionCount: 0,
            lastModified: project.lastSelectedAt,
            sessions: [],
          })),
        },
    })),
    preferences,
  )
  useSidebarManualOrders(model, preferences, preferencesLoaded, savePreferences)
  const sidebar = (
    <MultiServiceSidebar
      services={services}
      registry={registry}
      controllers={controllers.current}
      activeId={activeId}
      model={model}
      preferences={preferences}
      preferencesLoaded={preferencesLoaded}
      preferenceError={preferenceError}
      onPreferencesChange={(patch) =>
        void savePreferences(
          patch.sortMode === 'manual' ? { ...patch, orders: sidebarManualOrders(model, preferences.orders) } : patch,
        )
      }
      onSearch={openSearch}
      onActivate={activate}
      onSettings={() => controllers.current.get(activeId)?.openSettings()}
    />
  )
  const remoteSettings = <RemoteSettings services={services} registry={registry} onRemove={remove} />
  return (
    <>
      {services.map((service) => {
        const client = registry.get(service.id)
        return (
          <App
            key={service.id}
            bridge={client.bridge}
            host={client.host}
            plugins={client.plugins}
            call={(method, args) => client.rpc(method, args)}
            hostId={service.hostId}
            hostAddress={service.address}
            hostLocal={service.local}
            nativeWindow={nativeWindow}
            localPlatform={service.local && client.nativePlatformAvailable}
            onHostConnection={() => {}}
            onBootComplete={onBootComplete}
            serviceUI={{
              serviceId: service.id,
              active: service.id === activeId,
              appearanceBridge: registry.local.bridge,
              services,
              sidebar,
              remoteSettings,
              onController: captureController,
              onLocation: changeLocation,
              onSearch: openSearch,
            }}
          />
        )
      })}
      <SessionSearchDialog
        searchHistory={searchHistory}
        open={searchOpen}
        onOpenChange={setSearchOpen}
        entries={model.sessions}
        serviceLabels={Object.fromEntries(
          services.filter((service) => !service.local).map((service) => [service.id, serviceAddress(service.address)]),
        )}
        onSelect={(entry) => activate(entry.serviceId, (controller) => controller.switchSession(entry.session.path))}
      />
    </>
  )
}
