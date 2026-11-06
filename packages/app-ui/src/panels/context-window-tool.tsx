import { useCallback, useEffect, useState, type ComponentProps } from 'react'
import type { HostApi, SessionRef } from '@pi-meme/contracts/app-host'
import type { ContextRequest, ContextWindowApi } from '@pi-meme/contracts/context-window'
import { ContextWindowPanel } from '@pi-meme/context-window/ui/context-window-panel'
import { ContextUsageRing } from '@pi-meme/models/ui/context-usage-ring'

export function useContextWindowApi(host: HostApi) {
  const [supported, setSupported] = useState<HostApi>()
  useEffect(() => {
    let current = true
    void host
      .capabilities()
      .then((value) => {
        if (current) setSupported(value.features.includes('context-window') ? host : undefined)
      })
      .catch(() => {
        if (current) setSupported(undefined)
      })
    return () => {
      current = false
    }
  }, [host])
  return supported === host ? host.contextWindow : undefined
}

function subscribe(host: HostApi, sessionId: string, listener: () => void) {
  let stopped = false
  let release: (() => void) | undefined
  void host.events
    .subscribe({ sessionId }, (event) => {
      if (event.type === 'context-window' || event.type === 'resync') listener()
    })
    .then((unsubscribe) => {
      if (stopped) unsubscribe()
      else release = unsubscribe
    })
    .catch(() => {})
  return () => {
    stopped = true
    release?.()
  }
}

export function ContextWindowTool({
  host,
  api,
  session,
  visible,
  reducedMotion,
  sessionName,
}: {
  host: HostApi
  api: ContextWindowApi
  session: SessionRef
  visible: boolean
  reducedMotion?: boolean
  sessionName?: string
}) {
  const onChange = useCallback(
    (listener: () => void) => subscribe(host, session.sessionId, listener),
    [host, session.sessionId],
  )
  return <ContextWindowPanel {...{ api, session, visible, reducedMotion, sessionName, onChange }} />
}

export function SessionContextUsage({
  host,
  api,
  session,
  active,
  onOpenContext,
  ...props
}: ComponentProps<typeof ContextUsageRing> & {
  host: HostApi
  api?: ContextWindowApi
  session?: SessionRef
  active: boolean
}) {
  const owner = session ? JSON.stringify([session.hostId, session.sessionId]) : ''
  const [snapshot, setSnapshot] = useState<{ owner: string; request?: ContextRequest }>()
  useEffect(() => {
    if (!api || !session || !active) return
    let stopped = false
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const page = await api.list(session, { limit: 1 })
        if (!stopped) setSnapshot({ owner, request: page.requests[0] })
      } catch {
        /* Older/disconnected Hosts retain the SDK's available total. */
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 1500)
    const release = subscribe(host, session.sessionId, () => void refresh())
    return () => {
      stopped = true
      clearInterval(timer)
      release()
    }
  }, [host, api, session?.hostId, session?.sessionId, owner, active])
  return (
    <ContextUsageRing
      {...props}
      context={snapshot?.owner === owner ? snapshot.request : undefined}
      onOpenContext={api && session ? onOpenContext : undefined}
    />
  )
}
