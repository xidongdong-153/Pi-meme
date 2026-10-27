import { useState } from 'react'
import { ChevronDown, Plus, Search, SquarePen } from 'lucide-react'
import type { HostService } from '@pi-meme/contracts/host'
import type { SidebarPreferences, SidebarPreferencesPatch } from '@pi-meme/contracts/settings'
import { cn } from '@pi-meme/ui/lib/utils'
import { BrandMark } from '@pi-meme/ui/components/brand-mark'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { ProjectItem } from '@pi-meme/workspace/ui/sidebar/project-item'
import { SessionItem } from '@pi-meme/workspace/ui/sidebar/session-item'
import { SidebarMenus } from '@pi-meme/workspace/ui/sidebar/sidebar-menus'
import {
  SidebarPreferencesMenu,
  SidebarSection,
  SidebarSortable,
  type SidebarDragProps,
} from '@pi-meme/workspace/ui/sidebar/sidebar-controls'
import type {
  buildSidebarModel,
  SidebarEntry,
  SidebarProjectEntry,
  SidebarSessionEntry,
} from '@pi-meme/workspace/ui/sidebar/sidebar-model'
import { serviceLabel, servicePaused, serviceStatus, type ServiceController, type ServiceRegistry } from './service-ui'
import { RemoteProjectDetails } from './remote-project-details'
import { useShortcuts } from '../shortcuts/shortcut-provider'

export function MultiServiceSidebar({
  services,
  registry,
  controllers,
  activeId,
  model,
  preferences,
  preferencesLoaded = true,
  preferenceError,
  onPreferencesChange,
  onSearch,
  onActivate,
  onSettings: _onSettings,
}: {
  services: HostService[]
  registry: ServiceRegistry
  controllers: Map<string, ServiceController>
  activeId: string
  model: ReturnType<typeof buildSidebarModel>
  preferences: SidebarPreferences
  preferencesLoaded?: boolean
  preferenceError: string
  onPreferencesChange: (patch: SidebarPreferencesPatch) => void
  onSearch: () => void
  onActivate: (id: string, work: (controller: ServiceController) => Promise<boolean>) => void
  onSettings: () => void
}) {
  const shortcuts = useShortcuts()
  const searchShortcut = shortcuts.getShortcutLabel('searchSessions')
  const newChatShortcut = shortcuts.getShortcutLabel('newChat')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [recentsLimit, setRecentsLimit] = useState(8)
  const [all, setAll] = useState<Set<string>>(() => new Set())
  const [showAllProjects, setShowAllProjects] = useState(false)
  const active = controllers.get(activeId)
  const servicesById = new Map(services.map((service) => [service.id, service]))
  const manual = preferences.sortMode === 'manual'
  const activeService = servicesById.get(activeId)
  const activePaused = activeService ? servicePaused(activeService) : false
  const sourceFor = (service: HostService, path: string) =>
    service.local
      ? undefined
      : {
          label: serviceLabel(service),
          description: `${serviceLabel(service)} · ${service.transport === 'ssh' ? 'SSH' : 'HTTPS'} · ${serviceStatus(service)}\n${path}`,
          connected: service.status === 'connected',
          disabledReason:
            service.status !== 'connected'
              ? servicePaused(service)
                ? '连接已暂停，请先恢复连接'
                : '远程未连接，请连接后操作'
              : undefined,
        }
  const toggle = (key: string, setter: typeof setExpanded) =>
    setter((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const saveOrder = (listKey: string, keys: string[]) => onPreferencesChange({ orders: { [listKey]: keys } })

  const renderSession = (entry: SidebarSessionEntry, pinned: boolean, dragProps?: SidebarDragProps) => {
    const { serviceId, session } = entry
    const service = servicesById.get(serviceId)!
    const controller = controllers.get(serviceId)
    const snapshot = controller?.sessions ?? service.sessions
    const activePath = controller?.switchingToPath ?? snapshot?.activeSessionPath
    const source = sourceFor(service, session.sourceProjectCwd ?? session.cwd)
    return (
      <SidebarMenus
        canOpenProject={service.local && registry.get(serviceId).nativePlatformAvailable}
        bridge={registry.get(serviceId).bridge}
        pinnedPaths={snapshot?.pinnedPaths ?? []}
        disabledReason={source?.disabledReason}
        onNewSession={(cwd) => onActivate(serviceId, (chat) => chat.newSessionInProject(cwd))}
        onTogglePin={(path) => void controller?.togglePin(path)}
        onChanged={async () => {
          await controller?.refreshMenu()
        }}
        onDeleted={async (result) => {
          await controller?.applyMenuDeletion(result)
        }}
      >
        <div data-service-id={serviceId}>
          <SessionItem
            source={source}
            dragProps={dragProps}
            session={session}
            projectName={entry.projectName}
            variant={pinned ? 'pinned' : 'recent'}
            isActive={
              activeId === serviceId &&
              (activePath ? activePath === session.path : snapshot?.activeSessionId === session.id)
            }
            isPinned={pinned}
            onSwitchSession={(path) => onActivate(serviceId, (chat) => chat.switchSession(path))}
            onTogglePin={(path) => void controller?.togglePin(path)}
            onPrefetchSession={(path) => {
              if (service.status === 'connected') {
                const bridge = registry.get(serviceId).bridge
                void bridge.prefetchSession(path).catch(() => {})
              }
            }}
          />
        </div>
      </SidebarMenus>
    )
  }
  const renderProject = (entry: SidebarProjectEntry, pinned: boolean, dragProps: SidebarDragProps) => {
    const { serviceId, project, key } = entry
    const service = servicesById.get(serviceId)!
    const controller = controllers.get(serviceId)
    const snapshot = controller?.sessions ?? service.sessions
    const selected = activeId === serviceId
    const source = sourceFor(service, project.cwd)
    const openNewSession = (cwd: string) => {
      setExpanded((previous) => new Set(previous).add(key))
      onActivate(serviceId, (chat) => chat.newSessionInProject(cwd))
    }
    return (
      <SidebarMenus
        canOpenProject={service.local && registry.get(serviceId).nativePlatformAvailable}
        bridge={registry.get(serviceId).bridge}
        pinnedPaths={snapshot?.pinnedPaths ?? []}
        disabledReason={source?.disabledReason}
        onNewSession={openNewSession}
        onTogglePin={(path) => void controller?.togglePin(path)}
        onChanged={async () => {
          await controller?.refreshMenu()
          await registry.refresh(serviceId)
        }}
        onDeleted={async (result) => {
          await controller?.applyMenuDeletion(result)
          await registry.refresh(serviceId)
        }}
      >
        <div className="min-w-0" data-service-id={serviceId}>
          <ProjectItem
            serviceId={serviceId}
            source={source}
            details={
              !service.local ? (
                <RemoteProjectDetails
                  service={service}
                  project={project}
                  pinned={pinned}
                  registry={registry}
                  onTogglePin={() => void controller?.togglePin(project.cwd)}
                />
              ) : undefined
            }
            dragProps={dragProps}
            project={project}
            cwd={selected ? (controller?.connection.sourceProjectCwd ?? controller?.connection.cwd ?? '') : ''}
            isExpanded={expanded.has(key)}
            isPinned={pinned}
            isItemsExpandedAll={all.has(key)}
            pinnedSet={new Set(snapshot?.pinnedPaths ?? [])}
            activeSessionId={selected ? snapshot?.activeSessionId : undefined}
            activeSessionPath={selected ? (controller?.switchingToPath ?? snapshot?.activeSessionPath) : undefined}
            onToggle={() => toggle(key, setExpanded)}
            onToggleItems={() => toggle(key, setAll)}
            onNewSessionInProject={openNewSession}
            onSelectProject={
              preferences.groupMode === 'merged' && !pinned
                ? (cwd) => onActivate(serviceId, (chat) => chat.selectLocation({ kind: 'project', cwd }))
                : undefined
            }
            sortable={{
              serviceId,
              enabled: manual,
              onReorder: (keys) => saveOrder(`project:${key}`, keys),
            }}
            onTogglePin={(path) => void controller?.togglePin(path)}
            onSwitchSession={(path) => onActivate(serviceId, (chat) => chat.switchSession(path))}
            onPrefetchSession={(path) => {
              if (service.status === 'connected') {
                const bridge = registry.get(serviceId).bridge
                void bridge.prefetchSession(path).catch(() => {})
              }
            }}
          />
        </div>
      </SidebarMenus>
    )
  }
  const renderEntry = (entry: SidebarEntry, listKey: string, keys: string[], pinned = false) => (
    <SidebarSortable
      key={entry.key}
      itemKey={entry.key}
      listKey={listKey}
      keys={keys}
      enabled={listKey === 'recents' ? manual : preferencesLoaded}
      onReorder={(next) => saveOrder(listKey, next)}
    >
      {entry.kind === 'project'
        ? (dragProps) => renderProject(entry, pinned, dragProps)
        : pinned
          ? (dragProps) => renderSession(entry, pinned, dragProps)
          : renderSession(entry, pinned)}
    </SidebarSortable>
  )
  const visibleProjects = showAllProjects
    ? model.projects
    : model.projects.filter(
        ({ serviceId, project }, index) =>
          index < 5 ||
          (serviceId === activeId && project.cwd === (active?.connection.sourceProjectCwd ?? active?.connection.cwd)) ||
          project.sessions.some((session) => session.running),
      )
  const visibleRecents = model.recents.filter(
    ({ serviceId, session }, index) =>
      index < recentsLimit ||
      session.running ||
      (serviceId === activeId &&
        (session.id === active?.connection.sessionKey || session.path === active?.connection.sessionFile)),
  )
  const projectKeys = model.projects.map((entry) => entry.key)
  const pinnedKeys = model.pinned.map((entry) => entry.key)
  const recentKeys = model.recents.map((entry) => entry.key)
  const toggleSection = (id: keyof SidebarPreferences['collapsed']) =>
    onPreferencesChange({ collapsed: { [id]: !preferences.collapsed[id] } })

  return (
    <aside
      aria-label="侧边栏"
      className="appearance-sidebar flex h-full w-full flex-col border-r border-border bg-card/60 select-none"
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/40 px-3 text-xs font-semibold">
        <div className="flex items-center gap-2">
          <BrandMark size={20} />
          Pi meme
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="搜索聊天"
              onClick={onSearch}
              className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Search className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>搜索聊天{searchShortcut ? ` · ${searchShortcut}` : ''}</TooltipContent>
        </Tooltip>
      </div>
      <button
        type="button"
        onClick={() => onActivate(activeId, (chat) => chat.newSession())}
        disabled={activePaused}
        title={activePaused ? '连接已暂停，请先恢复连接' : newChatShortcut ? `新聊天（${newChatShortcut}）` : '新聊天'}
        className="mx-3 my-1.5 flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-secondary"
      >
        <SquarePen className="size-4" />
        新聊天
      </button>
      {preferenceError && (
        <p role="alert" className="px-3 text-xs text-destructive">
          {preferenceError}
        </p>
      )}
      <div className="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto pl-3 pr-1.5 py-2 [scrollbar-gutter:stable]">
        {model.pinned.length > 0 && (
          <SidebarSection
            id="pinned"
            title="置顶"
            collapsed={preferences.collapsed.pinned}
            onToggle={() => toggleSection('pinned')}
          >
            {model.pinned.map((entry) => renderEntry(entry, 'pinned', pinnedKeys, true))}
          </SidebarSection>
        )}
        {preferences.groupMode === 'projects' && (
          <SidebarSection
            id="projects"
            title="项目"
            collapsed={preferences.collapsed.projects}
            onToggle={() => toggleSection('projects')}
            actions={
              <>
                <SidebarPreferencesMenu
                  preferences={preferences}
                  disabled={!preferencesLoaded}
                  onChange={onPreferencesChange}
                />
                <button
                  type="button"
                  aria-label="新建项目"
                  disabled={activePaused}
                  title={activePaused ? '连接已暂停，请先恢复连接' : '新建项目'}
                  onClick={() =>
                    void (active?.openProjectDialog ? active.openProjectDialog() : active?.chooseDirectory())
                  }
                  className="rounded p-1 hover:bg-secondary"
                >
                  <Plus className="size-3.5" />
                </button>
              </>
            }
          >
            {visibleProjects.map((entry) => renderEntry(entry, 'projects', projectKeys))}
            {model.projects.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAllProjects((value) => !value)}
                className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer rounded transition-colors w-full text-left"
              >
                <ChevronDown
                  className={cn('size-3 transition-transform duration-200', showAllProjects && 'rotate-180')}
                />
                <span>{showAllProjects ? '收起' : '展开显示'}</span>
              </button>
            )}
          </SidebarSection>
        )}
        <SidebarSection
          id="recents"
          title="最近"
          collapsed={preferences.collapsed.recents}
          onToggle={() => toggleSection('recents')}
          actions={
            preferences.groupMode === 'merged' && (
              <>
                <SidebarPreferencesMenu
                  preferences={preferences}
                  disabled={!preferencesLoaded}
                  onChange={onPreferencesChange}
                />
                <button
                  type="button"
                  aria-label="新聊天"
                  title={newChatShortcut ? `新聊天（${newChatShortcut}）` : '新聊天'}
                  onClick={() => onActivate(activeId, (chat) => chat.newSession())}
                  className="rounded p-1 hover:bg-secondary"
                >
                  <SquarePen className="size-3.5" />
                </button>
              </>
            )
          }
        >
          {visibleRecents.map((entry) => renderEntry(entry, 'recents', recentKeys))}
          {model.recents.length > 8 && (
            <button
              type="button"
              onClick={() =>
                setRecentsLimit((limit) =>
                  limit >= model.recents.length ? 8 : Math.min(limit + 8, model.recents.length),
                )
              }
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {recentsLimit >= model.recents.length ? '收起' : '加载更多'}
            </button>
          )}
        </SidebarSection>
      </div>
    </aside>
  )
}
