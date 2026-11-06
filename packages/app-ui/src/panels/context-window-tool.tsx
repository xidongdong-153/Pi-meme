import { useCallback, useEffect, useState } from 'react'
import type { HostApi, SessionRef } from '@pi-meme/contracts/app-host'
import type { ContextRequest, ContextWindowApi } from '@pi-meme/contracts/context-window'
import { ContextWindowPanel } from '@pi-meme/context-window/ui/context-window-panel'
import type { PanelDataFact } from '../layout/panel-availability'
import { panelsRetiredEvent } from '../layout/panel-layout'

export function useContextWindowApi(host: HostApi) {
  const [supported, setSupported] = useState<HostApi>()
  useEffect(() => {
    let current = true
    let confirmed: boolean | undefined
    let sequence = 0
    let release: (() => void) | undefined
    const refresh = async () => {
      const request = ++sequence
      try {
        const value = await host.capabilities()
        if (!current || request !== sequence) return
        const available = value.features.includes('context-window')
        if (confirmed === true && !available)
          window.dispatchEvent(
            new CustomEvent(panelsRetiredEvent, {
              detail: { hostId: value.hostId, panels: [{ id: 'builtin:context-window' }] },
            }),
          )
        confirmed = available
        setSupported(available ? host : undefined)
      } catch {
        /* 暂时断线不撤销已经确认的能力。 */
      }
    }
    void refresh()
    void host.events
      .subscribe({}, (event) => {
        if (event.type === 'resync' && (event.value as { reason?: string }).reason !== 'disconnected') void refresh()
      })
      .then((unsubscribe) => {
        if (!current) unsubscribe()
        else {
          release = unsubscribe
          void refresh()
        }
      })
      .catch(() => {})
    return () => {
      current = false
      sequence++
      release?.()
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
      else {
        release = unsubscribe
        // 订阅建立后补读，覆盖首次查询与订阅之间的事件。
        listener()
      }
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

export function useSessionContextRequest(
  host: HostApi,
  api: ContextWindowApi | undefined,
  session: SessionRef | undefined,
  active: boolean,
) {
  const owner = session ? JSON.stringify([session.hostId, session.sessionId]) : ''
  const [snapshot, setSnapshot] = useState<{
    api: ContextWindowApi
    owner: string
    request?: ContextRequest
    fact: PanelDataFact
  }>()
  const [retryRevision, setRetryRevision] = useState(0)
  const retry = useCallback(() => setRetryRevision((value) => value + 1), [])
  useEffect(() => {
    if (!api || !session || !active) return
    let stopped = false
    let pending = false
    let again = false
    let epoch = 0
    const refresh = async () => {
      if (stopped || document.hidden) return
      if (pending) {
        again = true
        return
      }
      pending = true
      const requestEpoch = epoch
      try {
        const page = await api.list(session, { limit: 1 })
        if (!stopped && requestEpoch === epoch) {
          const request = page.requests[0]
          setSnapshot((previous) =>
            previous?.api === api &&
            previous.owner === owner &&
            previous.fact.status === 'ready' &&
            previous.request?.id === request?.id &&
            previous.request?.revision === request?.revision
              ? previous
              : {
                  api,
                  owner,
                  request,
                  fact: {
                    status: 'ready',
                    value: Boolean(request),
                    revision: `${request?.id ?? ''}:${request?.revision ?? ''}`,
                  },
                },
          )
        }
      } catch (cause) {
        if (!stopped && requestEpoch === epoch)
          setSnapshot((previous) => {
            const retained = previous?.api === api && previous.owner === owner ? previous : undefined
            const error = cause instanceof Error ? cause.message : String(cause)
            if (retained?.fact.status === 'error' && retained.fact.error === error) return retained
            return {
              api,
              owner,
              request: retained?.request,
              fact: { status: 'error', value: retained?.fact.value, error },
            }
          })
      } finally {
        pending = false
        if (again && !stopped) {
          again = false
          void refresh()
        }
      }
    }
    const invalidate = () => {
      epoch++
      void refresh()
    }
    const release = subscribe(host, session.sessionId, invalidate)
    void refresh()
    const timer = setInterval(() => void refresh(), 1500)
    document.addEventListener('visibilitychange', invalidate)
    return () => {
      stopped = true
      epoch++
      clearInterval(timer)
      release()
      document.removeEventListener('visibilitychange', invalidate)
    }
  }, [host, api, session?.hostId, session?.sessionId, owner, active, retryRevision])
  const current = snapshot?.api === api && snapshot?.owner === owner ? snapshot : undefined
  return { request: current?.request, fact: current?.fact ?? { status: 'unknown' as const }, retry }
}
