import { useState } from 'react'
import { Plus, Settings, SquarePen } from 'lucide-react'
import type { PiProjectGroup } from '@pi-meme/contracts/sessions'
import type { HostService } from '@pi-meme/contracts/host'
import { BrandMark } from '@pi-meme/ui/components/brand-mark'
import { ProjectItem } from '@pi-meme/workspace/ui/sidebar/project-item'
import { SessionItem } from '@pi-meme/workspace/ui/sidebar/session-item'
import { SidebarMenus } from '@pi-meme/workspace/ui/sidebar/sidebar-menus'
import { serviceAddress, type ServiceController, type ServiceRegistry } from './service-ui'

export function MultiServiceSidebar({
  services,
  registry,
  controllers,
  activeId,
  onActivate,
  onSettings,
}: {
  services: HostService[]
  registry: ServiceRegistry
  controllers: Map<string, ServiceController>
  activeId: string
  onActivate: (id: string, work: (controller: ServiceController) => Promise<boolean>) => void
  onSettings: () => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [recentsLimit, setRecentsLimit] = useState(8)
  const [all, setAll] = useState<Set<string>>(() => new Set())
  const active = controllers.get(activeId)
  const projects = services
    .flatMap((service) => {
      const snapshot = controllers.get(service.id)?.sessions ?? service.sessions
      const groups =
        snapshot?.projects ??
        service.projects.map((project) => ({
          ...project,
          sessionCount: 0,
          lastModified: project.lastSelectedAt,
          sessions: [],
        }))
      return groups.map((project) => ({ service, project }))
    })
    .sort((a, b) => b.project.lastModified.localeCompare(a.project.lastModified))
  const toggle = (key: string, setter: typeof setExpanded) =>
    setter((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const renderSession = (
    service: HostService,
    session: import('@pi-meme/contracts/sessions').PiSessionSummary,
    section: string,
  ) => {
    const controller = controllers.get(service.id)
    const snapshot = controller?.sessions ?? service.sessions
    return (
      <SidebarMenus
        key={`${section}:${service.id}:${session.path}`}
        canOpenProject={service.local}
        bridge={registry.get(service.id).bridge}
        pinnedPaths={snapshot?.pinnedPaths ?? []}
        onNewSession={() => {}}
        onTogglePin={(path) => void controller?.togglePin(path)}
        onChanged={async () => {
          await controller?.refreshMenu()
        }}
        onDeleted={async (result) => {
          await controller?.applyMenuDeletion(result)
        }}
      >
        <div>
          {!service.local && (
            <p className="px-2 text-[0.625rem] text-muted-foreground">{serviceAddress(service.address)}</p>
          )}
          <SessionItem
            session={session}
            variant="recent"
            isActive={activeId === service.id && snapshot?.activeSessionPath === session.path}
            isPinned={snapshot?.pinnedPaths.includes(session.path) ?? false}
            onSwitchSession={(path) => onActivate(service.id, (chat) => chat.switchSession(path))}
            onTogglePin={(path) => void controller?.togglePin(path)}
            onPrefetchSession={() => {}}
          />
        </div>
      </SidebarMenus>
    )
  }
  const recents = services
    .flatMap((service) => {
      const recents = (controllers.get(service.id)?.sessions ?? service.sessions)?.recents ?? []
      return recents.map((session) => ({ service, session }))
    })
    .sort((a, b) => b.session.modified.localeCompare(a.session.modified))
  const pinned = recents.filter(({ service, session }) =>
    (controllers.get(service.id)?.sessions ?? service.sessions)?.pinnedPaths.includes(session.path),
  )
  const renderProject = (service: HostService, project: PiProjectGroup, section: string) => {
    const controller = controllers.get(service.id)
    const key = `${service.id}:${project.cwd}`
    const snapshot = controller?.sessions ?? service.sessions
    const selected = activeId === service.id
    return (
      <SidebarMenus
        key={`${section}:${key}`}
        canOpenProject={service.local}
        bridge={registry.get(service.id).bridge}
        pinnedPaths={snapshot?.pinnedPaths ?? []}
        onNewSession={(cwd) => onActivate(service.id, (chat) => chat.newSessionInProject(cwd))}
        onTogglePin={(path) => void controller?.togglePin(path)}
        onChanged={async () => {
          await controller?.refreshMenu()
          await registry.refresh(service.id)
        }}
        onDeleted={async (result) => {
          await controller?.applyMenuDeletion(result)
          await registry.refresh(service.id)
        }}
      >
        <div className="min-w-0" data-service-id={service.id}>
          {!service.local && (
            <p className="truncate px-2.5 pt-1 text-[0.625rem] text-muted-foreground" title={service.address}>
              {serviceAddress(service.address)}
              {service.status !== 'connected' && ' · 未连接'}
            </p>
          )}
          <ProjectItem
            project={project}
            cwd={selected ? (controller?.connection.sourceProjectCwd ?? controller?.connection.cwd ?? '') : ''}
            isExpanded={expanded.has(key)}
            isPinned={snapshot?.pinnedPaths.includes(project.cwd) ?? false}
            isItemsExpandedAll={all.has(key)}
            pinnedSet={new Set(snapshot?.pinnedPaths ?? [])}
            activeSessionId={selected ? snapshot?.activeSessionId : undefined}
            activeSessionPath={selected ? snapshot?.activeSessionPath : undefined}
            onToggle={() => toggle(key, setExpanded)}
            onToggleItems={() => toggle(key, setAll)}
            onNewSessionInProject={(cwd) => onActivate(service.id, (chat) => chat.newSessionInProject(cwd))}
            onTogglePin={(path) => void controller?.togglePin(path)}
            onSwitchSession={(path) => onActivate(service.id, (chat) => chat.switchSession(path))}
            onPrefetchSession={(path) => {
              if (service.status === 'connected') {
                const bridge = registry.get(service.id).bridge
                void bridge.prefetchSession(path).catch(() => {})
              }
            }}
          />
        </div>
      </SidebarMenus>
    )
  }
  const pinnedProjects = projects.filter(({ service, project }) =>
    (controllers.get(service.id)?.sessions ?? service.sessions)?.pinnedPaths.includes(project.cwd),
  )
  return (
    <aside
      aria-label="侧边栏"
      className="appearance-sidebar flex h-full w-full flex-col border-r border-border bg-card/60 select-none"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/40 px-3 text-xs font-semibold">
        <BrandMark size={20} />
        pi-meme
      </div>
      <button
        type="button"
        onClick={() => void active?.newSession()}
        className="mx-3 my-1.5 flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-secondary"
      >
        <SquarePen className="size-4" />
        新聊天
      </button>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2">
        <div className="flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
          <span>项目</span>
          <button type="button" aria-label="新建项目" title="新建项目" onClick={() => void active?.chooseDirectory()}>
            <Plus className="size-3.5" />
          </button>
        </div>
        {projects.map(({ service, project }) => renderProject(service, project, 'project'))}
        {services.some(
          (service) => (controllers.get(service.id)?.sessions ?? service.sessions)?.standaloneSessions?.length,
        ) && <p className="px-2 pt-3 text-xs text-muted-foreground">未归属项目</p>}
        {services.flatMap((service) => {
          const sessions = (controllers.get(service.id)?.sessions ?? service.sessions)?.standaloneSessions ?? []
          return sessions.map((session) => renderSession(service, session, 'standalone'))
        })}
        {(pinned.length > 0 || pinnedProjects.length > 0) && (
          <p className="px-2 pt-3 text-xs text-muted-foreground">置顶</p>
        )}
        {pinnedProjects.map(({ service, project }) => renderProject(service, project, 'pinned'))}
        {pinned.map(({ service, session }) => renderSession(service, session, 'pinned'))}
        {recents.length > 0 && <p className="px-2 pt-3 text-xs text-muted-foreground">最近</p>}
        {recents
          .filter(
            ({ service, session }, index) =>
              index < recentsLimit ||
              session.running ||
              (activeId === service.id &&
                (session.id === active?.connection.sessionKey || session.path === active?.connection.sessionFile)),
          )
          .map(({ service, session }) => renderSession(service, session, 'recent'))}
        {recents.length > 8 && (
          <button
            type="button"
            onClick={() =>
              setRecentsLimit((limit) => (limit >= recents.length ? 8 : Math.min(limit + 8, recents.length)))
            }
            className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {recentsLimit >= recents.length ? '收起' : '加载更多'}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="设置"
        onClick={onSettings}
        className="flex shrink-0 items-center border-t border-border p-3 text-muted-foreground hover:text-foreground"
      >
        <Settings className="size-4" />
      </button>
    </aside>
  )
}
