import type { PiMessage } from '@pi-meme/contracts/pi'
import type { AgentMailboxMessage } from '@pi-meme/contracts/collaboration'
import type { ChatState, TurnChunk } from './types'

const collaborationTools = new Set([
  'spawn_agent',
  'send_message',
  'followup_task',
  'interrupt_agent',
  'list_agents',
  'wait_agent',
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
  const nativeResults = chat.messages.flatMap((message) => {
    if (message.role !== 'custom' || message.customType !== 'pi-meme-collaboration') return []
    if (!message.details || typeof message.details !== 'object') return []
    const details = message.details as Partial<AgentMailboxMessage> & { messageId?: string }
    return details.fromAgentId && details.kind === 'result'
      ? [{ ...details, id: details.messageId, createdAt: new Date(message.timestamp).toISOString() }]
      : []
  })
  for (const message of [...(chat.agentMessages ?? []), ...nativeResults]) {
    if (message.kind !== 'result') continue
    const agent = chat.agents?.find((entry) => entry.agentId === message.fromAgentId)
    const currentRun = agent && (!message.runId || message.runId === agent.runId)
    const runStatus = message.status ?? (currentRun ? agent.status : undefined)
    const status = terminalLabels[runStatus as keyof typeof terminalLabels]
    if (runStatus && !status) continue
    const key = `agent-status-${message.fromAgentId}:${message.runId ?? message.id}`
    if (byRun.has(key)) continue
    byRun.set(key, {
      type: 'agent_status',
      key,
      name: message.name || agent?.name || '子代理',
      status: status ?? '已结束',
      timestamp: Date.parse(message.completedAt ?? message.createdAt),
    })
  }
  return { messages, live, tools, agentStatuses: [...byRun.values()] }
}
