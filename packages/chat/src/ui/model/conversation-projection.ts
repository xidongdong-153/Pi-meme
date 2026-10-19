import type { PiMessage } from '@pi-meme/contracts/pi'
import type { AgentMailboxMessage, AgentSummary, CollaborationResults } from '@pi-meme/contracts/collaboration'
import type { ChatState, TurnChunk } from './types'

const collaborationTools = new Set([
  'spawn_agent',
  'send_message',
  'followup_task',
  'interrupt_agent',
  'list_agents',
  'wait_agent',
  'finish_agent',
])
const terminalLabels = {
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
  stopped: '已停止',
} as const
type AgentStatusTurn = Extract<TurnChunk, { type: 'agent_status' }>

function mainMessage(message: PiMessage): PiMessage | undefined {
  if (
    message.role === 'custom' &&
    (message.customType === 'pi-meme-collaboration' ||
      message.customType === 'pi-meme-collaboration-control' ||
      message.customType === 'pi-meme-goal-control' ||
      message.customType === 'pi-meme-goal-context' ||
      !message.display)
  )
    return
  if (message.role === 'toolResult' && collaborationTools.has(message.toolName)) return
  if (message.role === 'assistant')
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === 'toolCall' && collaborationTools.has(part.name) ? { type: 'text', text: '' } : part,
      ),
    }
  return message
}

/** 只改变主对话的显示内容，原消息、草稿和发送目标继续由会话状态保存。 */
export function projectMainConversation(chat: ChatState) {
  const messages = chat.messages.flatMap((message) => {
    const projected = mainMessage(message)
    return projected ? [projected] : []
  })
  const live = chat.live ? (mainMessage(chat.live) as ChatState['live']) : null
  const hiddenTools = new Set(
    Object.values(chat.tools)
      .filter((tool) => collaborationTools.has(tool.name ?? ''))
      .map((tool) => tool.id),
  )
  const tools = Object.fromEntries(
    Object.entries(chat.tools).filter(
      ([id, tool]) => !hiddenTools.has(id) && !hiddenTools.has(tool.parentToolCallId ?? ''),
    ),
  )
  const byRun = new Map<string, AgentStatusTurn>()
  const agents = new Map(chat.agents?.map((agent) => [agent.agentId, agent]))
  const started = (agentId: string, name: string, startedAt?: string, avatar?: AgentSummary['avatar']) => {
    if (!startedAt) return
    const timestamp = Date.parse(startedAt)
    if (!Number.isFinite(timestamp)) return
    const key = `agent-start-${agentId}:${timestamp}`
    if (!byRun.has(key))
      byRun.set(key, {
        type: 'agent_status',
        phase: 'started',
        agents: [{ agentId, name, ...(avatar ? { avatar } : {}) }],
        key,
        status: '开始工作',
        timestamp,
      })
  }
  const agentStarted = (agent: AgentSummary) => {
    if (!agent.parentAgentId || !agent.runId || agent.status === 'idle' || agent.status === 'starting') return
    started(agent.agentId, agent.name, agent.runStartedAt, agent.avatar)
  }
  for (const agent of agents.values()) agentStarted(agent)
  for (const message of chat.messages) {
    if (message.role !== 'toolResult' || message.isError || !message.details || typeof message.details !== 'object')
      continue
    if (message.toolName === 'spawn_agent') agentStarted(message.details as CollaborationResults['spawn_agent'])
    if (message.toolName === 'followup_task') {
      const details = message.details as CollaborationResults['followup_task']
      if (!details.queued && details.agent) agentStarted(details.agent)
    }
  }
  const nativeResults = chat.messages.flatMap((message) => {
    if (message.role !== 'custom' || message.customType !== 'pi-meme-collaboration') return []
    if (!message.details || typeof message.details !== 'object') return []
    const details = message.details as Partial<AgentMailboxMessage> & { messageId?: string }
    return details.fromAgentId && details.kind === 'result'
      ? [{ ...details, id: details.messageId, createdAt: new Date(message.timestamp).toISOString() }]
      : []
  })
  const currentResults = [...agents.values()].flatMap((agent) =>
    agent.parentAgentId && agent.runId && agent.status in terminalLabels
      ? [
          {
            id: agent.runId,
            kind: 'result' as const,
            fromAgentId: agent.agentId,
            name: agent.name,
            avatar: agent.avatar,
            status: agent.status,
            runId: agent.runId,
            startedAt: agent.runStartedAt,
            completedAt: agent.runCompletedAt,
            createdAt: agent.updatedAt,
          },
        ]
      : [],
  )
  for (const message of [...(chat.agentMessages ?? []), ...nativeResults, ...currentResults]) {
    if (message.kind !== 'result' || !message.fromAgentId) continue
    const agent = agents.get(message.fromAgentId)
    const currentRun = agent && (!message.runId || message.runId === agent.runId)
    const runStatus = message.status ?? (currentRun ? agent.status : undefined)
    const status = terminalLabels[runStatus as keyof typeof terminalLabels]
    if (runStatus && !status) continue
    const name = message.name || agent?.name || '子代理'
    const avatar = message.avatar ?? agent?.avatar
    started(message.fromAgentId, name, message.startedAt ?? (currentRun ? agent.runStartedAt : undefined), avatar)
    const timestamp = Date.parse(message.completedAt ?? message.createdAt)
    if (!Number.isFinite(timestamp)) continue
    const key = `agent-status-${message.fromAgentId}:${message.runId ?? message.id}`
    if (byRun.has(key)) continue
    byRun.set(key, {
      type: 'agent_status',
      phase: 'finished',
      agents: [{ agentId: message.fromAgentId, name, ...(avatar ? { avatar } : {}) }],
      key,
      status: status ?? '已结束',
      timestamp,
    })
  }
  return {
    messages,
    live,
    tools,
    agentStatuses: [...byRun.values()].sort(
      (a, b) => a.timestamp - b.timestamp || a.agents[0].agentId.localeCompare(b.agents[0].agentId),
    ),
  }
}
