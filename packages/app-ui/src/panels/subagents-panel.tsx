import { memo, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { OverflowTooltip, TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import type { HostApi, SessionRef } from '@pi-meme/contracts/app-host'
import { ArrowLeft } from 'lucide-react'
import type { AgentSummary, AgentStatus } from '@pi-meme/contracts/collaboration'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import { Conversation } from '@pi-meme/chat/ui/conversation/conversation'
import { THINKING_LEVEL_LABELS } from '@pi-meme/models/ui/thinking-config'
import { AgentAvatar } from '@pi-meme/ui/components/agent-avatar'
import { ErrorLine } from '@pi-meme/ui/components/error-line'
import { Button } from '@pi-meme/ui/components/ui/button'
import { formatAgentName } from '@pi-meme/ui/lib/agent-name'
import { AgentConversationStore } from './agent-conversation-store'

const labels: Record<AgentStatus, string> = {
  idle: '空闲',
  starting: '启动中',
  running: '运行中',
  waiting_children: '等待反馈',
  waiting_input: '等待回答',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
  stopped: '已停止',
}
export function agentRunning(agent: AgentSummary) {
  return ['idle', 'starting', 'running', 'waiting_children', 'waiting_input'].includes(agent.status)
}
export function agentElapsed(agent: AgentSummary, now: number) {
  if (!agent.runStartedAt) return '尚未运行'
  const end = agent.runCompletedAt ? Date.parse(agent.runCompletedAt) : now
  const seconds = Math.max(0, Math.floor((end - Date.parse(agent.runStartedAt)) / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
export function agentFinishedAgo(agent: AgentSummary, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(agent.runCompletedAt || agent.updatedAt)) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86400)} 天前`
}
export function orderAgents(agents: AgentSummary[], opened: boolean) {
  const group = agents.filter((agent) => agentRunning(agent) === opened)
  const ids = new Set(group.map((agent) => agent.agentId))
  const children = new Map<string, AgentSummary[]>()
  const roots: AgentSummary[] = []
  for (const agent of group) {
    if (agent.parentAgentId && ids.has(agent.parentAgentId)) {
      const siblings = children.get(agent.parentAgentId) || []
      siblings.push(agent)
      children.set(agent.parentAgentId, siblings)
    } else roots.push(agent)
  }
  const completedAt = (agent: AgentSummary): number =>
    Math.max(
      Date.parse(agent.runCompletedAt || agent.updatedAt),
      ...(children.get(agent.agentId) || []).map(completedAt),
    )
  const sort = (entries: AgentSummary[]) =>
    entries.sort((a, b) => (opened ? 0 : completedAt(b) - completedAt(a)) || a.taskPath.localeCompare(b.taskPath))
  const ordered: AgentSummary[] = []
  const visit = (agent: AgentSummary) => {
    ordered.push(agent)
    for (const child of sort(children.get(agent.agentId) || [])) visit(child)
  }
  for (const agent of sort(roots)) visit(agent)
  return ordered
}
function noop() {}

type FileScope = { files: HostApi['files']; fileSession?: SessionRef }
type AgentConversationProps = FileScope & { bridge: DesktopBridge; id: string; onBack: () => void }
type SubagentsPanelProps = FileScope & { bridge: DesktopBridge; sessionKey?: string }

const AgentConversation = memo(({ bridge, id, onBack, files, fileSession }: AgentConversationProps) => {
  const [store] = useState(() => new AgentConversationStore(bridge, id))
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [copyError, setCopyError] = useState('')
  useEffect(() => {
    void store.start()
    return () => store.close()
  }, [store])
  const hostId = fileSession?.hostId
  const sessionId = fileSession?.sessionId
  const loadImage = useMemo(() => {
    if (!hostId || !sessionId) return undefined
    // 子代理与根会话共享工作目录；原生 Agent sessionId 不是 Host 的稳定 SessionRef。
    const ref = { hostId, sessionId }
    return (relativePath: string) => files.preview(ref, relativePath)
  }, [files, hostId, sessionId])
  const name = view.agent ? formatAgentName(view.agent.name) : '子代理'
  const status = view.agent ? (view.agent.isPaused ? '已暂停' : labels[view.agent.status]) : '读取中'
  const model = view.agent?.model?.name || view.agent?.model?.id || '模型未知'
  const thinking = view.agent?.thinkingLevel ? THINKING_LEVEL_LABELS[view.agent.thinkingLevel] : '强度未知'
  return (
    <>
      <header className="flex min-h-12 min-w-0 shrink-0 items-center gap-2 border-b border-border px-2 py-2">
        <TooltipHint content="返回子代理列表">
          <Button size="icon-sm" variant="ghost" className="shrink-0" onClick={onBack} aria-label="返回子代理列表">
            <ArrowLeft />
          </Button>
        </TooltipHint>
        <AgentAvatar seed={id} name={view.agent?.name} avatar={view.agent?.avatar} className="size-6 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <OverflowTooltip content={name}>
              <p className="min-w-0 flex-1 truncate text-xs font-medium">{name}</p>
            </OverflowTooltip>
            <div className="ml-auto flex min-w-0 max-w-[55%] items-center gap-1 text-xs text-muted-foreground">
              <OverflowTooltip content={model}>
                <span className="min-w-0 truncate">{model}</span>
              </OverflowTooltip>
              <span aria-hidden="true" className="shrink-0">
                ·
              </span>
              <span className="shrink-0">{thinking}</span>
            </div>
          </div>
          <p className="mt-0.5 flex flex-wrap gap-x-2 text-[0.6875rem] leading-4 text-muted-foreground">
            <span role="status">{status}</span>
            {view.agent && !agentRunning(view.agent) && view.agent.runStartedAt && (
              <span className="tabular-nums">用时 {agentElapsed(view.agent, Date.now())}</span>
            )}
          </p>
        </div>
      </header>
      {view.loading && (
        <p role="status" className="p-3 text-xs">
          正在读取对话…
        </p>
      )}
      {(view.error || copyError) && <ErrorLine message={view.error || copyError} className="p-3 text-xs" />}
      <Conversation
        chat={view.chat}
        agent={view.agent}
        sessionKey={view.agent?.sessionKey}
        cwd={view.agent?.cwd}
        fileSession={fileSession}
        loadImage={loadImage}
        readOnly
        agentOnly
        canEditMessages={false}
        onEditMessage={noop}
        onForkReply={noop}
        onCopyError={setCopyError}
      />
    </>
  )
})

const SubagentsContent = memo(({ bridge, sessionKey, files, fileSession }: SubagentsPanelProps) => {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let active = true
    let revision = 0
    const refresh = () => {
      if (!active || !sessionKey) return
      const readingRevision = ++revision
      void bridge
        .getAgents(sessionKey)
        .then((value) => {
          if (!active || readingRevision !== revision) return
          setAgents(value.filter((agent) => agent.parentAgentId && agent.rootSessionKey === sessionKey))
          setNow(Date.now())
          setError('')
        })
        .catch((cause) => {
          if (active && readingRevision === revision) setError(String(cause))
        })
    }
    refresh()
    const offEvent = bridge.onEvent((record) => {
      if (
        !active ||
        record.event.type !== 'agents_update' ||
        (!record.event.agents.some((agent) => agent.rootSessionKey === sessionKey) && record.sessionKey !== sessionKey)
      )
        return
      revision++
      setAgents(record.event.agents.filter((agent) => agent.parentAgentId && agent.rootSessionKey === sessionKey))
      setNow(Date.now())
      setError('')
    })
    const offConnection = bridge.onConnection((connection) => {
      if (connection.status === 'ready' || connection.status === 'idle') refresh()
    })
    return () => {
      active = false
      offEvent()
      offConnection()
    }
  }, [bridge, sessionKey])
  const ticking = agents.some((agent) => agentRunning(agent) && agent.status !== 'idle' && !agent.isPaused)
  const interval = ticking ? 1000 : agents.some((agent) => !agentRunning(agent)) ? 60000 : 0
  useEffect(() => {
    if (!interval) return
    const timer = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(timer)
  }, [interval])
  if (selected)
    return (
      <AgentConversation
        key={selected}
        bridge={bridge}
        id={selected}
        files={files}
        fileSession={fileSession}
        onBack={() => setSelected(undefined)}
      />
    )
  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 py-4 text-xs">
      {error && <ErrorLine message={error} className="mb-2 text-xs" />}
      {[true, false].map((opened) => {
        const group = orderAgents(agents, opened)
        return (
          <section
            key={String(opened)}
            className="mb-6 space-y-2"
            aria-label={opened ? '运行中子代理' : '已结束子代理'}
          >
            <h3 className="mb-3 px-2 font-medium text-muted-foreground">
              {opened ? '已开启' : '已结束'} · {group.length}
            </h3>
            {!group.length && (
              <p className="px-2 py-2 text-muted-foreground">{opened ? '没有已开启的子代理' : '没有已结束的子代理'}</p>
            )}
            {group.map((agent) => (
              <button
                key={agent.agentId}
                type="button"
                className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{
                  marginLeft: Math.max(0, agent.depth - 1) * 8,
                  width: `calc(100% - ${Math.max(0, agent.depth - 1) * 8}px)`,
                }}
                onClick={() => setSelected(agent.agentId)}
              >
                <AgentAvatar seed={agent.agentId} name={agent.name} avatar={agent.avatar} className="size-6 shrink-0" />
                <OverflowTooltip content={formatAgentName(agent.name)}>
                  <span className="min-w-0 flex-1 truncate font-medium">{formatAgentName(agent.name)}</span>
                </OverflowTooltip>
                <span className="shrink-0 text-right tabular-nums text-muted-foreground">
                  {opened
                    ? agent.isPaused
                      ? '已暂停'
                      : agent.status === 'idle'
                        ? labels[agent.status]
                        : `${labels[agent.status]} · ${agentElapsed(agent, now)}`
                    : `${agent.status === 'completed' ? '' : `${labels[agent.status]} · `}${agentFinishedAgo(agent, now)}`}
                </span>
              </button>
            ))}
          </section>
        )
      })}
    </div>
  )
})

export const SubagentsPanel = memo(({ bridge, sessionKey, files, fileSession }: SubagentsPanelProps) => (
  <SubagentsContent
    key={sessionKey || ''}
    bridge={bridge}
    sessionKey={sessionKey}
    files={files}
    fileSession={fileSession}
  />
))
