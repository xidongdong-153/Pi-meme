import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceBridge } from '@pi-meme/contracts/desktop'
import type { PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import { SessionActivity } from './session-activity'

export function useSessions(bridge: Pick<WorkspaceBridge, 'getSessions' | 'onSessionsChanged'>, enabled = true) {
  const [sessions, setSessions] = useState<PiSessionsSnapshot | null>(null)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const mounted = useRef(false)
  const requestId = useRef(0)
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
    if (!enabled) return
    const id = ++requestId.current
    try {
      setSessionsLoading(true)
      const data = await bridgeRef.current.getSessions()
      if (mounted.current && id === requestId.current) setSessions(activity.current.apply(data))
    } catch {
      // 容错处理
    } finally {
      if (mounted.current && id === requestId.current) setSessionsLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setSessions(null)
      setSessionsLoading(false)
      return
    }
    void refreshSessions()
    const off = bridge.onSessionsChanged?.(() => void refreshSessions())
    const timer = setInterval(() => void refreshSessions(), 2000)
    return () => {
      off?.()
      clearInterval(timer)
      requestId.current += 1
    }
  }, [bridge, refreshSessions, enabled])

  const setActiveSession = useCallback((sessionPath?: string, sessionId?: string) => {
    activity.current.select(sessionPath, sessionId)
    setSessions((prev) => (prev ? activity.current.apply(prev) : prev))
  }, [])

  return { sessions, sessionsLoading, refreshSessions, setActiveSession }
}
