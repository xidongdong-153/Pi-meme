import { realpath } from 'node:fs/promises'
import type { PiSessionPool } from '@pi-meme/pi-runtime/session-pool'
import { deleteSessionFiles, normalizeCwd, scanProjectSessions, validateSessionFile } from './session-files'
import type { ProjectStore } from './project-store'
import type { PiRuntime } from '@pi-meme/pi-runtime/runtime'
import { text } from '@pi-meme/contracts/ipc'
import type { SessionService } from './session-service'
import type { PiProjectGroup, PiSessionSummary } from '@pi-meme/contracts/sessions'
import { mergeRuntimeSessions } from './session-groups'
import type { SessionHistoryData } from './session-reader'
import { readSessionCwd } from './session-reader'

export type WorkspaceHandlerContext = {
  mutations?: Pick<PiSessionPool, 'renameSession' | 'deleteSessions' | 'assertWorkspaceAvailable'>
  removePins?: (paths: string[]) => Promise<unknown>
  beforeDelete?: (paths: string[]) => Promise<void>
  afterDelete?: (
    result: import('@pi-meme/contracts/desktop').WorkspaceDeletionResult,
    prepared: any,
    cwd?: string,
  ) => Promise<void>
  prepareDelete?: (paths: string[], cwd?: string) => Promise<any>
  projects?: ProjectStore
  pi: PiRuntime
  sessions: SessionService
  getPinnedPaths: () => string[]
  getRuntimeSessions?: () => PiSessionSummary[]
  getSessionTasks?: () => Promise<Map<string, NonNullable<PiSessionSummary['scheduledTask']>>>
  getRuntimeHistory?: (path: string) => SessionHistoryData | null
}

export function createWorkspaceHandlers({
  pi,
  mutations,
  removePins,
  beforeDelete,
  afterDelete,
  prepareDelete,
  projects,
  sessions,
  getPinnedPaths,
  getRuntimeSessions,
  getSessionTasks,
}: WorkspaceHandlerContext) {
  const getProjects = async () => {
    if (!projects) return []
    const snapshot = await sessions.getSnapshot(pi.getActiveSession(), getPinnedPaths())
    const cwds = await Promise.all(
      snapshot.projects.map(async (group) => {
        const session = group.sessions[0]
        if (!session) return undefined
        return session.path.startsWith('runtime:') ? session.cwd : readSessionCwd(session.path).catch(() => undefined)
      }),
    )
    return projects.list([
      ...cwds.filter((cwd): cwd is string => Boolean(cwd)),
      ...(getRuntimeSessions?.() ?? []).map((session) => session.cwd),
      pi.cwd,
    ])
  }
  const normalizeProject = async (value: unknown) => {
    text(value)
    if (!value.startsWith('/')) throw new Error('项目目录必须是绝对路径')
    const cwd = await normalizeCwd(value)
    if (!projects || projects.kind(cwd) !== 'project') throw new Error('目标不是项目目录')
    return cwd
  }
  const parseName = (value: unknown) => {
    if (typeof value !== 'string') throw new Error('名称必须是文本')
    const name = value.replace(/[\r\n]+/g, ' ').trim()
    if (!name) throw new Error('名称不能为空')
    return name
  }
  const preview = async (cwd: string) => {
    const directories = projects?.projectDirectories(cwd) ?? [cwd]
    const root = await sessions.getSessionsDirectory()
    const scanned = await Promise.all(directories.map((directory) => scanProjectSessions(root, directory)))
    const disk = { paths: scanned.flatMap((item) => item.paths), warnings: scanned.flatMap((item) => item.warnings) }
    const runtime = await Promise.all(
      (getRuntimeSessions?.() ?? [])
        .filter((session) => !session.temporary)
        .map(async (session) => ({ ...session, cwd: await normalizeCwd(session.cwd) })),
    )
    return {
      ...disk,
      paths: [
        ...new Set([
          ...disk.paths,
          ...runtime.filter((session) => directories.includes(session.cwd)).map((session) => session.path),
        ]),
      ].sort(),
    }
  }
  const finishDeletion = async (result: import('@pi-meme/contracts/desktop').WorkspaceDeletionResult, cwd?: string) => {
    sessions.invalidate()
    try {
      await removePins?.([
        ...result.deletedPaths,
        ...result.deletedKeys,
        ...(cwd && !result.errors.length ? [cwd] : []),
      ])
      if (cwd && !result.errors.length) await projects!.remove(cwd)
    } catch (cause) {
      result.errors.push(`会话已删除，清理项目或置顶失败：${String(cause)}`)
    }
    return result
  }
  return {
    'project:rename': async (value: unknown, nextName: unknown) => {
      const cwd = await normalizeProject(value)
      mutations!.assertWorkspaceAvailable(cwd)
      await projects!.renameProject(cwd, parseName(nextName))
    },
    'project:delete-preview': async (value: unknown) => preview(await normalizeProject(value)),
    'project:remove': async (value: unknown, expected: unknown) => {
      const cwd = await normalizeProject(value)
      if (!Array.isArray(expected) || expected.some((item) => typeof item !== 'string'))
        throw new Error('会话删除清单无效')
      const paths = expected as string[]
      const root = await sessions.getSessionsDirectory()
      const prepared = await prepareDelete?.(paths, cwd)
      return mutations!.deleteSessions(
        paths,
        cwd,
        async () => {
          const current = await preview(cwd)
          if (JSON.stringify(current.paths) !== JSON.stringify([...new Set(paths)].sort()))
            throw new Error('项目会话清单已变化，请重新确认删除')
          await beforeDelete?.(current.paths)
          const deleted = await deleteSessionFiles(root, current.paths)
          return { ...deleted, warnings: current.warnings }
        },
        async (result) => {
          await finishDeletion(result, cwd)
          try {
            await afterDelete?.(result, prepared, cwd)
          } catch (cause) {
            result.errors.push(`会话已删除，后置清理失败：${String(cause)}`)
          }
          return result
        },
      )
    },
    'session:rename': async (value: unknown, nextName: unknown) => {
      text(value)
      if (!value.startsWith('runtime:')) await validateSessionFile(await sessions.getSessionsDirectory(), value)
      else if (!(getRuntimeSessions?.() ?? []).some((session) => session.path === value || session.id === value))
        throw new Error('目标会话不存在')
      await mutations!.renameSession(value, parseName(nextName))
      sessions.invalidate()
    },
    'session:delete': async (value: unknown) => {
      text(value)
      const root = await sessions.getSessionsDirectory()
      if (!value.startsWith('runtime:')) await validateSessionFile(root, value)
      else if (!(getRuntimeSessions?.() ?? []).some((session) => session.path === value || session.id === value))
        throw new Error('目标会话不存在')
      const prepared = await prepareDelete?.([value])
      return mutations!.deleteSessions(
        [value],
        undefined,
        async () => {
          await beforeDelete?.([value])
          return deleteSessionFiles(root, [value])
        },
        async (result) => {
          await finishDeletion(result)
          try {
            await afterDelete?.(result, prepared)
          } catch (cause) {
            result.errors.push(`会话已删除，后置清理失败：${String(cause)}`)
          }
          return result
        },
      )
    },
    'workspace:projects': getProjects,
    'pi:sessions': async () => {
      let snapshot = await sessions.getSnapshot(pi.getActiveSession(), getPinnedPaths())
      if (projects) {
        const canonical = new Map<string, Promise<string>>()
        const normalize = (cwd: string) => {
          if (!canonical.has(cwd))
            canonical.set(
              cwd,
              realpath(cwd).catch(() => cwd),
            )
          return canonical.get(cwd)!
        }
        const groups = new Map<string, PiProjectGroup>()
        for (const group of snapshot.projects) {
          const headerCwd =
            group.sessions.find((session) => session.cwd)?.cwd ??
            (group.sessions[0] && (await readSessionCwd(group.sessions[0].path).catch(() => undefined)))
          if (!headerCwd) continue
          const cwd = await normalize(headerCwd)
          const saved = groups.get(cwd)
          const entries = await Promise.all(
            group.sessions.map(async (session) => ({ ...session, cwd: await normalize(session.cwd || headerCwd) })),
          )
          const sessions = [
            ...new Map([...(saved?.sessions ?? []), ...entries].map((session) => [session.path, session])).values(),
          ]
          groups.set(cwd, { ...group, cwd, sessionCount: sessions.length, sessions })
        }
        snapshot = {
          ...snapshot,
          projects: [...groups.values()],
          recents: await Promise.all(
            snapshot.recents.map(async (session) => ({ ...session, cwd: await normalize(session.cwd) })),
          ),
        }
      }
      const active = pi.getActiveSession()
      const merged = mergeRuntimeSessions(
        { ...snapshot, activeSessionId: active.sessionId, activeSessionPath: active.sessionFile },
        getRuntimeSessions?.() ?? [],
      )
      if (!merged.projects.some((project) => project.cwd === pi.cwd))
        merged.projects.push({
          cwd: pi.cwd,
          name: pi.cwd.split('/').filter(Boolean).at(-1) ?? pi.cwd,
          sessionCount: 0,
          lastModified: '1970-01-01T00:00:00.000Z',
          sessions: [],
        })
      if (projects) {
        const all = [
          ...new Map(
            [...merged.projects.flatMap((group) => group.sessions), ...merged.recents].map((session) => [
              session.path,
              session,
            ]),
          ).values(),
        ]
        merged.standaloneSessions = all
          .filter((session) => projects.kind(session.cwd) === 'standalone')
          .map((session) => ({ ...session, workspaceKind: 'standalone' as const }))
          .sort((a, b) => Date.parse(b.completedAt ?? b.created) - Date.parse(a.completedAt ?? a.created))
        merged.projects = merged.projects.filter((group) => projects.kind(group.cwd) === 'project')
        merged.recents = merged.recents.map((session) => ({ ...session, workspaceKind: projects.kind(session.cwd) }))
        const registered = await getProjects().catch(() => [])
        for (const group of merged.projects) {
          group.name = registered.find((project) => project.cwd === group.cwd)?.name ?? group.name
        }
        for (const project of registered) {
          if (!merged.projects.some((group) => group.cwd === project.cwd))
            merged.projects.push({
              cwd: project.cwd,
              name: project.name,
              sessionCount: 0,
              lastModified: project.lastSelectedAt || '1970-01-01T00:00:00.000Z',
              sessions: [],
            })
        }
      }
      if (projects) {
        const decorate = (session: PiSessionSummary) => ({
          ...session,
          sourceProjectCwd: projects.sourceProjectCwd(session.cwd),
        })
        const grouped = new Map<string, PiProjectGroup>()
        for (const group of merged.projects) {
          const cwd = projects.sourceProjectCwd(group.cwd) ?? group.cwd
          const saved = grouped.get(cwd)
          const entries = [...(saved?.sessions ?? []), ...group.sessions.map(decorate)]
          grouped.set(cwd, {
            ...group,
            cwd,
            name: (await projects.list([cwd])).find((project) => project.cwd === cwd)?.name ?? group.name,
            sessions: entries,
            sessionCount: entries.length,
            lastModified: saved && saved.lastModified > group.lastModified ? saved.lastModified : group.lastModified,
          })
        }
        merged.projects = [...grouped.values()]
        merged.recents = merged.recents.map(decorate)
      }
      if (getSessionTasks) {
        const tasks = await getSessionTasks()
        const decorate = (session: PiSessionSummary): PiSessionSummary => ({
          ...session,
          scheduledTask: tasks.get(session.path),
        })
        merged.recents = merged.recents.map(decorate)
        merged.standaloneSessions = merged.standaloneSessions?.map(decorate)
        merged.projects = merged.projects.map((group) => ({ ...group, sessions: group.sessions.map(decorate) }))
      }
      return merged
    },
    'pi:new-session': () => pi.newSession(),
    'pi:switch-session': (value: unknown, window?: unknown) => {
      text(value)
      return pi.switchSession(value, window as import('@pi-meme/contracts/sessions').SessionWindow | undefined)
    },
  }
}
