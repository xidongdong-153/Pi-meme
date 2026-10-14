import { AgentAvatar } from '@pi-meme/ui/components/agent-avatar'
import { formatAgentName } from '@pi-meme/ui/lib/agent-name'

export function AgentStatusRow({
  agents,
  status,
}: {
  agents: Array<{ agentId: string; name: string }>
  status: string
}) {
  const names = agents.map((agent) => formatAgentName(agent.name))
  const name = names.length > 1 ? `${names.slice(0, -1).join('、')} 和 ${names.at(-1)}` : names[0]
  return (
    <p aria-label="子代理状态" className="flex items-start gap-2 py-2 text-sm text-muted-foreground">
      <span className="flex max-w-[40%] shrink-0 flex-wrap gap-1">
        {agents.map((agent) => (
          <AgentAvatar key={agent.agentId} seed={agent.agentId} name={agent.name} className="size-5" />
        ))}
      </span>
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {name} {status}
      </span>
    </p>
  )
}
