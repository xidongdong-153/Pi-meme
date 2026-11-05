import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceBridge } from '@pi-meme/contracts/desktop'
import type { PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import { SessionActivity } from './session-activity'

export function useSessions(
  bridge: Pick<WorkspaceBridge, 'getSessions' | 'onSessionsChanged'>,
  enabled = true,
  foreground = true,
) {
  const [sessions, setSessions] = useState<PiSessionsSnapshot | null>(null)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const hasSessions = useRef(false)
  const dirty = useRef(true)
  const mounted = useRef(false)
  const generation = useRef(0)
  const activePromise = useRef<Promise<void> | null>(null)
  const activity = useRef(new SessionActivity())
  const bridgeRef = useRef(bridge)
  bridgeRef.current = bridge

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refreshSessions = useCallback(async () => {
    if (!enabled || !mounted.current) return
    dirty.current = true
    if (document.hidden) return
    if (activePromise.current) return activePromise.current
    const currentGen = generation.current
    if (!hasSessions.current) setSessionsLoading(true)
    const runner = async () => {
      do {
        dirty.current = false
        try {
          const data = await bridgeRef.current.getSessions()
          if (mounted.current && generation.current === currentGen) {
            hasSessions.current = true
            const next = activity.current.apply(data)
            setSessions((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
          }
        } catch {
          // 读取失败时保留已有列表，后续事件、恢复可见或手动刷新可以重试。
        }
      } while (mounted.current && generation.current === currentGen && !document.hidden && dirty.current)
    }
    const task = runner().finally(() => {
      if (generation.current !== currentGen) return
      activePromise.current = null
      if (mounted.current) setSessionsLoading(false)
    })
    activePromise.current = task
    return task
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      hasSessions.current = false
      setSessions(null)
      setSessionsLoading(false)
      return
    }
    void refreshSessions()
    const off = bridge.onSessionsChanged?.(() => void refreshSessions())
    const resume = () => {
      if (!document.hidden) void refreshSessions()
    }
    document.addEventListener('visibilitychange', resume)
    return () => {
      off?.()
      document.removeEventListener('visibilitychange', resume)
      generation.current += 1
      activePromise.current = null
    }
  }, [bridge, refreshSessions, enabled])

  useEffect(() => {
    if (foreground && dirty.current) void refreshSessions()
  }, [foreground, refreshSessions])

  const setActiveSession = useCallback((sessionPath?: string, sessionId?: string) => {
    activity.current.select(sessionPath, sessionId)
    setSessions((prev) => (prev ? activity.current.apply(prev) : prev))
  }, [])

  return { sessions, sessionsLoading, refreshSessions, setActiveSession }
}
