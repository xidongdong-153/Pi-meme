import { Fragment } from 'react'
import { AgentAvatar } from '@pi-meme/ui/components/agent-avatar'
import { formatAgentName } from '@pi-meme/ui/lib/agent-name'
import type { TurnChunk } from '../model/types'

export function AgentStatusRow({
  agents,
  status,
  onOpenAgent,
}: {
  agents: Extract<TurnChunk, { type: 'agent_status' }>['agents']
  status: string
  onOpenAgent?: (agentId: string) => void
}) {
  return (
    <p aria-label="子代理状态" className="conversation-event flex items-start gap-2 text-muted-foreground">
      <span className="flex max-w-[40%] shrink-0 flex-wrap gap-1 pt-[0.16em]">
        {agents.map((agent) => (
          <AgentAvatar
            key={agent.agentId}
            seed={agent.agentId}
            name={agent.name}
            avatar={agent.avatar}
            className="size-[1.4em]"
          />
        ))}
      </span>
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {agents.map((agent, index) => (
          <Fragment key={agent.agentId}>
            {index > 0 && (index === agents.length - 1 ? ' 和 ' : '、')}
            {onOpenAgent ? (
              <button
                type="button"
                className="conversation-agent-link"
                aria-label={`查看子代理：${formatAgentName(agent.name)}`}
                onClick={() => onOpenAgent(agent.agentId)}
              >
                {formatAgentName(agent.name)}
              </button>
            ) : (
              formatAgentName(agent.name)
            )}
          </Fragment>
        ))}{' '}
        <span className={status === '失败' ? 'text-destructive' : undefined}>{status}</span>
      </span>
    </p>
  )
}
