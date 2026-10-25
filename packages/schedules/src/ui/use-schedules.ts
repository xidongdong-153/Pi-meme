import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { ScheduledTask } from '@pi-meme/contracts/schedules'

export function useSchedules(host: HostApi, connected: boolean) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [supported, setSupported] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState<{ taskId: string; text: string }>()
  const request = useRef(0)
  const seen = useRef(new Set<string>())
  const refresh = useCallback(
    async (live = false) => {
      const id = ++request.current
      try {
        const result = await host.schedules.list()
        if (id !== request.current) return
        for (const task of result) {
          const run = task.latestUnreadRun ?? task.lastRun
          if (live && run?.unread && !seen.current.has(run.runId))
            setNotice({
              taskId: task.taskId,
              text: `${task.name}：${run.status === 'completed' ? '运行完成' : '运行未成功'}`,
            })
          if (run && !['starting', 'running'].includes(run.status)) seen.current.add(run.runId)
        }
        setTasks(result)
        setError('')
      } catch (cause) {
        if (id === request.current) setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [host],
  )
  useEffect(() => {
    if (!connected) return
    let disposed = false
    let ready = false
    let off: (() => void) | undefined
    setLoading(true)
    void (async () => {
      try {
        const capabilities = await host.capabilities()
        if (disposed) return
        const available = capabilities.features.includes('schedules')
        setSupported(available)
        if (!available) return
        off = await host.events.subscribe({}, (event) => {
          if (disposed) return
          if (event.type === 'resync') {
            ready = false
            void refresh().then(() => {
              if (!disposed) ready = true
            })
          } else if (event.type === 'schedule') void refresh(ready)
        })
        if (disposed) {
          off()
          return
        }
        await refresh()
        ready = true
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!disposed) setLoading(false)
      }
    })()
    return () => {
      disposed = true
      request.current++
      off?.()
    }
  }, [host, connected, refresh])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(setNotice, 6000, undefined)
    return () => clearTimeout(timer)
  }, [notice])
  return { tasks, supported, loading, error, connected, refresh, notice, dismissNotice: () => setNotice(undefined) }
}
