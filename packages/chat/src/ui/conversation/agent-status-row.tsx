import { AgentAvatar } from '@pi-meme/ui/components/agent-avatar'
import { formatAgentName } from '@pi-meme/ui/lib/agent-name'

export function AgentStatusRow({ agentId, name, status }: { agentId: string; name: string; status: string }) {
  return (
    <p aria-label="子代理状态" className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
      <AgentAvatar seed={agentId} name={name} className="size-5" />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {formatAgentName(name)} {status}
      </span>
    </p>
  )
}
