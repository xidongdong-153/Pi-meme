import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, GitFork, MessagesSquare } from 'lucide-react'
import type { HostApi, SessionRef } from '@pi-meme/contracts/app-host'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import type { ContextRequest, ContextWindowAgent, ContextWindowApi } from '@pi-meme/contracts/context-window'
import { Button } from '@pi-meme/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { formatAgentName } from '@pi-meme/ui/lib/agent-name'
import { agentStatusLabel } from './subagents-panel'
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
  agents,
  capturedAgents,
}: {
  host: HostApi
  api: ContextWindowApi
  session: SessionRef
  visible: boolean
  reducedMotion?: boolean
  sessionName?: string
  agents: AgentSummary[]
  capturedAgents?: ContextWindowAgent[]
}) {
  const [agentId, setAgentId] = useState<string>()
  const choices = useMemo(() => {
    if (!capturedAgents) return []
    const options = new Map<string, ContextWindowAgent & { status?: string }>()
    for (const agent of agents)
      options.set(agent.agentId, { agentId: agent.agentId, name: agent.name, status: agentStatusLabel(agent) })
    for (const agent of capturedAgents) if (!options.has(agent.agentId)) options.set(agent.agentId, agent)
    return [...options.values()]
  }, [agents, capturedAgents])
  const selected = choices.find((agent) => agent.agentId === agentId)
  const onChange = useCallback(
    (listener: () => void) => subscribe(host, session.sessionId, listener),
    [host, session.sessionId],
  )
  return (
    <>
      {visible && choices.length > 0 && (
        <div
          role="group"
          aria-label="查看对象"
          className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs"
        >
          <span className="text-muted-foreground">查看对象</span>
          <div className="ml-auto flex min-w-0 max-w-full items-center gap-1">
            <Button
              size="xs"
              variant={selected ? 'outline' : 'secondary'}
              aria-pressed={!selected}
              onClick={() => setAgentId(undefined)}
            >
              <MessagesSquare />
              主会话
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="xs"
                  variant={selected ? 'secondary' : 'outline'}
                  className="min-w-0"
                  aria-label={selected ? `切换子代理，当前为${formatAgentName(selected.name)}` : '选择子代理'}
                >
                  <GitFork />
                  <span className="truncate">
                    {selected ? formatAgentName(selected.name) : `子代理 · ${choices.length}`}
                  </span>
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="bottom"
                align="end"
                sideOffset={4}
                className="max-w-[min(22rem,calc(100vw-1.5rem))]"
                aria-label="选择子代理"
              >
                <DropdownMenuRadioGroup value={selected?.agentId ?? ''} onValueChange={setAgentId}>
                  {choices.map((agent) => (
                    <DropdownMenuRadioItem
                      key={agent.agentId}
                      value={agent.agentId}
                      textValue={formatAgentName(agent.name)}
                    >
                      <span className="truncate">{formatAgentName(agent.name)}</span>
                      {agent.status && (
                        <span className="ml-auto shrink-0 pl-2 text-muted-foreground">{agent.status}</span>
                      )}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}
      <ContextWindowPanel
        api={api}
        session={{ ...session, agentId: selected?.agentId }}
        sessionName={selected ? formatAgentName(selected.name) : sessionName}
        {...{ visible, reducedMotion, onChange }}
      />
    </>
  )
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
    subagents?: ContextWindowAgent[]
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
          const revision = JSON.stringify([request?.id, request?.revision, page.subagents])
          setSnapshot((previous) =>
            previous?.api === api &&
            previous.owner === owner &&
            previous.fact.status === 'ready' &&
            previous.fact.revision === revision
              ? previous
              : {
                  api,
                  owner,
                  request,
                  subagents: page.subagents,
                  fact: { status: 'ready', value: Boolean(request || page.subagents?.length), revision },
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
              subagents: retained?.subagents,
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
  return {
    request: current?.request,
    subagents: current?.subagents,
    fact: current?.fact ?? { status: 'unknown' as const },
    retry,
  }
}
