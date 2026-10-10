import { memo, useEffect, useState, useSyncExternalStore } from 'react'
import type { AgentSummary, AgentStatus } from '@pi-meme/contracts/collaboration'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import { Conversation } from '@pi-meme/chat/ui/conversation/conversation'
import { Button } from '@pi-meme/ui/components/ui/button'
import { AgentConversationStore } from './agent-conversation-store'

const labels: Record<AgentStatus, string> = {
  idle: '空闲',
  starting: '启动中',
  running: '运行中',
  waiting_children: '等待子任务',
  waiting_input: '等待回答',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
  stopped: '已停止',
}
export function agentRunning(agent: AgentSummary) {
  return ['starting', 'running', 'waiting_children', 'waiting_input'].includes(agent.status)
}
export function agentElapsed(agent: AgentSummary, now: number) {
  if (!agent.runStartedAt) return '尚未运行'
  const end = agent.runCompletedAt ? Date.parse(agent.runCompletedAt) : now
  const seconds = Math.max(0, Math.floor((end - Date.parse(agent.runStartedAt)) / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
function noop() {}

const AgentConversation = memo(({ bridge, id, onBack }: { bridge: DesktopBridge; id: string; onBack: () => void }) => {
  const [store] = useState(() => new AgentConversationStore(bridge, id))
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [copyError, setCopyError] = useState('')
  useEffect(() => {
    void store.start()
    return () => store.close()
  }, [store])
  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-border p-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          返回列表
        </Button>
        <div className="min-w-0 text-xs">
          <p className="truncate font-medium">{view.agent?.name || '子代理'}</p>
          <p className="truncate text-muted-foreground">
            {view.agent?.taskPath} · {view.agent ? labels[view.agent.status] : '读取中'}
          </p>
        </div>
      </header>
      {view.loading && (
        <p role="status" className="p-3 text-xs">
          正在读取对话…
        </p>
      )}
      {(view.error || copyError) && (
        <p role="alert" className="p-3 text-xs text-destructive">
          {view.error || copyError}
        </p>
      )}
      <Conversation
        chat={view.chat}
        readOnly
        canEditMessages={false}
        onEditMessage={noop}
        onSwitchMessageVersion={noop}
        onForkReply={noop}
        onCopyError={setCopyError}
      />
    </>
  )
})

export const SubagentsPanel = memo(({ bridge, sessionKey }: { bridge: DesktopBridge; sessionKey?: string }) => {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let active = true
    const refresh = () => {
      if (sessionKey)
        void bridge
          .getAgents(sessionKey)
          .then((value) => {
            if (active) setAgents(value.filter((agent) => agent.parentAgentId && agent.rootSessionKey === sessionKey))
          })
          .catch((cause) => {
            if (active) setError(String(cause))
          })
    }
    refresh()
    const offEvent = bridge.onEvent((record) => {
      if (
        record.event.type !== 'agents_update' ||
        (!record.event.agents.some((agent) => agent.rootSessionKey === sessionKey) && record.sessionKey !== sessionKey)
      )
        return
      setAgents(record.event.agents.filter((agent) => agent.parentAgentId && agent.rootSessionKey === sessionKey))
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
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  if (selected)
    return <AgentConversation key={selected} bridge={bridge} id={selected} onBack={() => setSelected(undefined)} />
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
      {error && (
        <p role="alert" className="mb-2 text-destructive">
          {error}
        </p>
      )}
      {!agents.length && <p className="text-muted-foreground">当前会话没有子代理任务。</p>}
      {[true, false].map((running) => {
        const group = agents
          .filter((agent) => agentRunning(agent) === running)
          .sort((a, b) => a.taskPath.localeCompare(b.taskPath))
        return group.length ? (
          <section
            key={String(running)}
            className="mb-4 space-y-2"
            aria-label={running ? '运行中子代理' : '已结束子代理'}
          >
            <h3 className="font-medium text-muted-foreground">
              {running ? '运行中' : '已结束'}（{group.length}）
            </h3>
            {group.map((agent) => (
              <button
                key={agent.agentId}
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-secondary"
                style={{
                  marginLeft: Math.max(0, agent.depth - 1) * 8,
                  width: `calc(100% - ${Math.max(0, agent.depth - 1) * 8}px)`,
                }}
                onClick={() => setSelected(agent.agentId)}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span>
                <span className="shrink-0 text-muted-foreground">{labels[agent.status]}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{agentElapsed(agent, now)}</span>
              </button>
            ))}
          </section>
        ) : null
      })}
    </div>
  )
})
