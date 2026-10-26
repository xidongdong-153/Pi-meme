import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceBridge } from '@pi-meme/contracts/desktop'
import type { PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import { SessionActivity } from './session-activity'

export function useSessions(bridge: Pick<WorkspaceBridge, 'getSessions' | 'onSessionsChanged'>, enabled = true) {
  const [sessions, setSessions] = useState<PiSessionsSnapshot | null>(null)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const activePromise = useRef<Promise<void> | null>(null)
  const subsequentGen = useRef<number | null>(null)
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
    if (activePromise.current) {
      subsequentGen.current = generation.current
      return activePromise.current
    }
    const currentGen = generation.current
    setSessionsLoading(true)
    const runner = async () => {
      do {
        subsequentGen.current = null
        try {
          const data = await bridgeRef.current.getSessions()
          if (mounted.current && generation.current === currentGen) setSessions(activity.current.apply(data))
        } catch {
          // 读取失败时保留已有列表，后续事件或轮询可以重试。
        }
      } while (mounted.current && generation.current === currentGen && subsequentGen.current === currentGen)
    }
    const task = runner().finally(() => {
      if (generation.current !== currentGen) return
      activePromise.current = null
      subsequentGen.current = null
      if (mounted.current) setSessionsLoading(false)
    })
    activePromise.current = task
    return task
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setSessions(null)
      setSessionsLoading(false)
      return
    }
    void refreshSessions()
    const off = bridge.onSessionsChanged?.(() => void refreshSessions())
    const timer = setInterval(() => {
      // 慢请求不因轮询不断追加读取；只有显式刷新和变更事件要求后续刷新。
      if (!activePromise.current) void refreshSessions()
    }, 2000)
    return () => {
      off?.()
      clearInterval(timer)
      generation.current += 1
      activePromise.current = null
      subsequentGen.current = null
    }
  }, [bridge, refreshSessions, enabled])

  const setActiveSession = useCallback((sessionPath?: string, sessionId?: string) => {
    activity.current.select(sessionPath, sessionId)
    setSessions((prev) => (prev ? activity.current.apply(prev) : prev))
  }, [])

  return { sessions, sessionsLoading, refreshSessions, setActiveSession }
}
