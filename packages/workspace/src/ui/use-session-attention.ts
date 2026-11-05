import { useEffect, useMemo, useState } from 'react'
import type { PiSessionsSnapshot, PiSessionSummary } from '@pi-meme/contracts/sessions'

function mergeRead(...records: Record<string, string>[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const record of records)
    for (const [path, time] of Object.entries(record))
      if (Number.isFinite(Date.parse(time)) && (!result[path] || Date.parse(time) > Date.parse(result[path]!)))
        result[path] = time
  return result
}

function readStorage(key: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    if (value && typeof value === 'object' && !Array.isArray(value))
      return Object.fromEntries(Object.entries(value).filter(([, time]) => typeof time === 'string'))
  } catch {
    // 本地记录不可用时仍可在当前窗口阅读会话。
  }
  return {}
}

function inputReadKey(path: string, requestId: string): string {
  return JSON.stringify(['input', path, requestId])
}

/** 已读状态属于当前客户端，按 Host 和原生会话路径隔离。 */
export function useSessionAttention(
  snapshot: PiSessionsSnapshot | null,
  hostId: string,
  viewedPath: string | undefined,
  visible: boolean,
  running = false,
) {
  const storageKey = `pi-meme:session-read:v1:${encodeURIComponent(hostId)}`
  const [saved, setSaved] = useState<{ key: string; read: Record<string, string> }>(() => ({ key: '', read: {} }))
  useEffect(() => {
    setSaved({ key: storageKey, read: readStorage(storageKey) })
    const changed = (event: StorageEvent) => {
      if (event.key !== storageKey) return
      const latest = readStorage(storageKey)
      setSaved((previous) => ({
        key: storageKey,
        read: mergeRead(previous.key === storageKey ? previous.read : {}, latest),
      }))
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [storageKey])

  useEffect(() => {
    if (saved.key !== storageKey) return
    const latest = readStorage(storageKey)
    const read = mergeRead(latest, saved.read)
    if (Object.keys(read).every((path) => latest[path] === read[path])) return
    try {
      // 其他窗口并发覆盖整份记录后，将 storage 事件合并出的并集补回持久存储。
      localStorage.setItem(storageKey, JSON.stringify(read))
    } catch {
      // 存储不可用时只保留当前窗口状态。
    }
  }, [saved, storageKey])

  useEffect(() => {
    if (!visible || !viewedPath || !snapshot || saved.key !== storageKey) return
    const mark = () => {
      if (document.hidden || !document.hasFocus()) return
      const session = [
        ...snapshot.recents,
        ...(snapshot.standaloneSessions ?? []),
        ...snapshot.projects.flatMap((project) => project.sessions),
      ].find((entry) => entry.path === viewedPath)
      if (!session) return
      const latest = mergeRead(saved.read, readStorage(storageKey))
      const updates: Record<string, string> = {}
      for (const id of session.inputRequestIds ?? []) {
        const key = inputReadKey(viewedPath, id)
        if (!latest[key]) updates[key] = new Date().toISOString()
      }
      if (
        session.completedAt &&
        Number.isFinite(Date.parse(session.completedAt)) &&
        !session.running &&
        !running &&
        !(Date.parse(latest[viewedPath] ?? '') >= Date.parse(session.completedAt))
      )
        updates[viewedPath] = session.completedAt
      if (!Object.keys(updates).length) return
      const read = mergeRead(latest, updates)
      try {
        localStorage.setItem(storageKey, JSON.stringify(read))
      } catch {
        // 存储不可用时保留当前窗口的已读状态。
      }
      setSaved({ key: storageKey, read })
    }
    mark()
    document.addEventListener('visibilitychange', mark)
    window.addEventListener('focus', mark)
    return () => {
      document.removeEventListener('visibilitychange', mark)
      window.removeEventListener('focus', mark)
    }
  }, [visible, viewedPath, snapshot, storageKey, saved, running])

  return useMemo(() => {
    if (!snapshot) return snapshot
    const decorate = (session: PiSessionSummary): PiSessionSummary => ({
      ...session,
      inputUnread: Boolean(
        session.needsInput &&
        (session.inputRequestIds?.length
          ? session.inputRequestIds.some(
              (id) => saved.key !== storageKey || !saved.read[inputReadKey(session.path, id)],
            )
          : true),
      ),
      unread: Boolean(
        saved.key === storageKey &&
        session.completedAt &&
        Number.isFinite(Date.parse(session.completedAt)) &&
        !session.running &&
        !(Date.parse(saved.read[session.path] ?? '') >= Date.parse(session.completedAt)),
      ),
    })
    return {
      ...snapshot,
      recents: snapshot.recents.map(decorate),
      standaloneSessions: snapshot.standaloneSessions?.map(decorate),
      projects: snapshot.projects.map((project) => ({ ...project, sessions: project.sessions.map(decorate) })),
    }
  }, [snapshot, saved, storageKey])
}
