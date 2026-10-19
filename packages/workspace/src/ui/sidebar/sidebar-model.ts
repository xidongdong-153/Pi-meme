import type { PiProjectGroup, PiSessionSummary, PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import type { SidebarPreferences } from '@pi-meme/contracts/settings'
import { skillMessageText } from '@pi-meme/contracts/skills'

export type SidebarProjectEntry = { kind: 'project'; key: string; serviceId: string; project: PiProjectGroup }
export type SidebarSessionEntry = {
  kind: 'session'
  key: string
  serviceId: string
  session: PiSessionSummary
  projectName: string
}
export type SidebarEntry = SidebarProjectEntry | SidebarSessionEntry

export function sidebarItemKey(serviceId: string, kind: 'project' | 'session', path: string): string {
  return JSON.stringify([serviceId, kind, path])
}
function timestamp(value: string): number {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}
function sessionTime(session: PiSessionSummary): number {
  return timestamp(session.completedAt ?? session.created)
}
function orderEntries<T extends { key: string }>(entries: T[], order: string[] | undefined): T[] {
  if (!order?.length) return entries
  const positions = new Map(order.map((key, index) => [key, index]))
  return [...entries].sort((a, b) => (positions.get(a.key) ?? Infinity) - (positions.get(b.key) ?? Infinity))
}
function recentSessions(entries: SidebarSessionEntry[]): SidebarSessionEntry[] {
  return [...entries].sort((a, b) => sessionTime(b.session) - sessionTime(a.session))
}
export function buildSidebarModel(
  sources: Array<{ serviceId: string; snapshot: PiSessionsSnapshot }>,
  preferences: SidebarPreferences,
): {
  pinned: SidebarEntry[]
  projects: SidebarProjectEntry[]
  recents: SidebarSessionEntry[]
  sessions: SidebarSessionEntry[]
} {
  const allSessions = new Map<string, SidebarSessionEntry>()
  const allProjects = new Map<string, SidebarProjectEntry>()
  const projectTimes = new Map<string, number>()
  const pinned: SidebarEntry[] = []
  const pinnedKeys = new Set<string>()
  const pinnedProjectSessions = new Set<string>()
  for (const { serviceId, snapshot } of sources) {
    const names = new Map(snapshot.projects.map((project) => [project.cwd, project.name]))
    const projectSessionNames = new Map(
      snapshot.projects.flatMap((project) => project.sessions.map((session) => [session.path, project.name] as const)),
    )
    const addSession = (
      session: PiSessionSummary,
      projectName = projectSessionNames.get(session.path) ??
        names.get(session.sourceProjectCwd ?? session.cwd) ??
        '无项目',
    ) => {
      const key = sidebarItemKey(serviceId, 'session', session.path)
      if (!allSessions.has(key))
        allSessions.set(key, {
          kind: 'session',
          key,
          serviceId,
          session,
          projectName: session.workspaceKind === 'standalone' ? '无项目' : projectName,
        })
      return key
    }
    for (const project of snapshot.projects) {
      const key = sidebarItemKey(serviceId, 'project', project.cwd)
      if (allProjects.has(key)) continue
      for (const session of project.sessions) addSession(session, project.name)
      projectTimes.set(
        key,
        project.sessions.length ? Math.max(...project.sessions.map(sessionTime)) : timestamp(project.lastModified),
      )
      allProjects.set(key, { kind: 'project', key, serviceId, project })
    }
    for (const session of snapshot.standaloneSessions ?? []) addSession(session)
    for (const session of snapshot.recents) addSession(session)
    for (const path of snapshot.pinnedPaths) {
      const project = allProjects.get(sidebarItemKey(serviceId, 'project', path))
      const entry = project ?? allSessions.get(sidebarItemKey(serviceId, 'session', path))
      if (!entry || pinnedKeys.has(entry.key)) continue
      pinnedKeys.add(entry.key)
      pinned.push(entry)
      if (project) {
        for (const session of project.project.sessions)
          pinnedProjectSessions.add(sidebarItemKey(serviceId, 'session', session.path))
      }
    }
  }
  const sessions = recentSessions([...allSessions.values()])
  const prepareProject = (entry: SidebarProjectEntry): SidebarProjectEntry => {
    let items = recentSessions(
      entry.project.sessions
        .map((session) => allSessions.get(sidebarItemKey(entry.serviceId, 'session', session.path))!)
        .filter((item) => !pinnedKeys.has(item.key)),
    )
    if (preferences.sortMode === 'manual') items = orderEntries(items, preferences.orders[`project:${entry.key}`])
    return { ...entry, project: { ...entry.project, sessions: items.map((item) => item.session) } }
  }
  const projects = [...allProjects.values()]
    .filter((entry) => !pinnedKeys.has(entry.key))
    .sort((a, b) => projectTimes.get(b.key)! - projectTimes.get(a.key)!)
    .map(prepareProject)
  let recents = sessions.filter((entry) => !pinnedKeys.has(entry.key) && !pinnedProjectSessions.has(entry.key))
  if (preferences.sortMode === 'manual') {
    recents = orderEntries(recents, preferences.orders.recents)
  }
  return {
    pinned: orderEntries(
      pinned.map((entry) => (entry.kind === 'project' ? prepareProject(entry) : entry)),
      preferences.orders.pinned,
    ),
    projects: orderEntries(projects, preferences.orders.projects),
    recents,
    sessions,
  }
}
export function reorderSidebarItems(keys: string[], key: string, targetKey: string): string[] {
  const from = keys.indexOf(key)
  const to = keys.indexOf(targetKey)
  if (from < 0 || to < 0 || from === to) return keys
  const next = [...keys]
  next.splice(from, 1)
  next.splice(to, 0, key)
  return next
}
export function sidebarSessionTitle(session: PiSessionSummary): string {
  return (
    session.name?.trim() ||
    skillMessageText(session.firstMessage ?? '')
      .trim()
      .split('\n')[0] ||
    '新会话'
  )
}
export function searchSidebarSessions(entries: SidebarSessionEntry[], query: string): SidebarSessionEntry[] {
  const text = query.trim().toLocaleLowerCase()
  if (!text) return recentSessions(entries).slice(0, 9)
  return entries.filter((entry) => sidebarSessionTitle(entry.session).toLocaleLowerCase().includes(text))
}

export function sidebarManualOrders(
  model: ReturnType<typeof buildSidebarModel>,
  orders: SidebarPreferences['orders'],
): Record<string, string[]> {
  const next = { ...orders }
  const append = (list: string, keys: string[]) => {
    const existing = orders[list] ?? []
    const seen = new Set(existing)
    const additions = keys.filter((key) => !seen.has(key))
    if (!Object.hasOwn(orders, list) || additions.length) next[list] = [...existing, ...additions]
  }
  append(
    'projects',
    [...model.projects, ...model.pinned.filter((entry) => entry.kind === 'project')].map((entry) => entry.key),
  )
  for (const list of ['pinned', 'recents'] as const)
    append(
      list,
      model[list].map((entry) => entry.key),
    )
  for (const entry of [...model.projects, ...model.pinned]) {
    if (entry.kind !== 'project') continue
    const key = `project:${entry.key}`
    append(
      key,
      entry.project.sessions.map((session) => sidebarItemKey(entry.serviceId, 'session', session.path)),
    )
  }
  return next
}
