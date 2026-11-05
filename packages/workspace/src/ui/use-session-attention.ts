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

/**
 * 已读基线：首次运行或新增未读状态后首次运行时只写一次。
 * 基线之前完成的会话一律算已读，升级后不会把历史会话整片标成未读。
 */
function readBaseline(key: string): string {
  try {
    const stored = localStorage.getItem(key)
    if (stored && Number.isFinite(Date.parse(stored))) return stored
    localStorage.setItem(key, new Date().toISOString())
    // 其他窗口可能同时写入更早的基线，以已落盘的值为准。
    const saved = localStorage.getItem(key)
    if (saved && Number.isFinite(Date.parse(saved))) return saved
  } catch {
    // 存储不可用时退回本次挂载时间，只影响当前窗口。
  }
  return new Date().toISOString()
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
  const baselineKey = `pi-meme:session-read-baseline:v1:${encodeURIComponent(hostId)}`
  const [saved, setSaved] = useState<{ key: string; baseline: string; read: Record<string, string> }>(() => ({
    key: '',
    baseline: '',
    read: {},
  }))
  useEffect(() => {
    setSaved({ key: storageKey, baseline: readBaseline(baselineKey), read: readStorage(storageKey) })
    const changed = (event: StorageEvent) => {
      if (event.key !== storageKey && event.key !== baselineKey) return
      const latest = readStorage(storageKey)
      setSaved((previous) =>
        previous.key === storageKey
          ? {
              key: storageKey,
              baseline: event.key === baselineKey ? readBaseline(baselineKey) : previous.baseline,
              read: mergeRead(previous.read, latest),
            }
          : previous,
      )
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [storageKey, baselineKey])

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
      setSaved({ ...saved, read })
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
    // 基线缺失时先渲染为已读，避免挂载首帧整片标蓝。
    const baseline = saved.key === storageKey ? Date.parse(saved.baseline) : Number.NaN
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
        session.completedAt &&
        Number.isFinite(Date.parse(session.completedAt)) &&
        !session.running &&
        Number.isFinite(baseline) &&
        Date.parse(session.completedAt) > baseline &&
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
