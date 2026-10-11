import type { AgentAccessMode } from './agent-access'
import type { Snapshot } from './desktop'
import type { PiExtensionDialogRequest, PiModel, ThinkingLevel } from './pi'
import type { TaskMode } from './plan'

export const collaborationLimits = { activeChildren: 4, depth: 2, identities: 16 } as const
export type AgentStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting_children'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'stopped'
export type AgentIdentity = {
  agentId: string
  rootAgentId: string
  parentAgentId?: string
  name: string
  taskPath: string
  depth: number
}
export type AgentExecution = AgentIdentity & {
  rootSessionKey: string
  sessionKey: string
  runId?: string
  rootTaskId: string
  epoch: number
  executionGeneration: number
}
export type AgentConversationOrigin = {
  parentAgentId: string
  inheritedLeafId: string | null
  inheritedEntryIds: string[]
}
export type AgentSummary = AgentExecution & {
  isPaused?: boolean
  conversationOrigin?: AgentConversationOrigin
  status: AgentStatus
  cwd: string
  sessionId?: string
  sessionFile?: string
  model?: PiModel
  thinkingLevel?: ThinkingLevel
  accessMode: AgentAccessMode
  mode: TaskMode
  task?: string
  report?: string
  error?: string
  updatedAt: string
  runStartedAt?: string
  runCompletedAt?: string
}
export type AgentMailboxMessage = {
  id: string
  fromAgentId: string
  toAgentId: string
  rootTaskId: string
  epoch: number
  runId?: string
  kind: 'message' | 'result'
  name?: string
  status?: AgentStatus
  completedAt?: string
  text: string
  createdAt: string
}
export type CollaborationRequests = {
  spawn_agent: { task_name: string; message: string; fork_turns?: 'all' | 'none' }
  send_message: { target: string; message: string }
  followup_task: { target: string; message: string }
  interrupt_agent: { target: string }
  list_agents: { path_prefix?: string }
  wait_agent: { targets?: string[]; timeout_ms?: number }
}
export type CollaborationResults = {
  spawn_agent: AgentSummary
  send_message: { messageId: string; delivered: boolean }
  followup_task: { agent: AgentSummary; queued: boolean }
  interrupt_agent: { agent: AgentSummary; previousStatus: AgentStatus }
  list_agents: { agents: AgentSummary[] }
  wait_agent: { agents: AgentSummary[]; messages: AgentMailboxMessage[]; timedOut: boolean }
}
export type CollaborationMethod = keyof CollaborationRequests
export type CollaborationRequest = {
  [K in CollaborationMethod]: { id: string; method: K; params: CollaborationRequests[K] }
}[CollaborationMethod]
export type CollaborationReply = { id: string; result?: CollaborationResults[CollaborationMethod]; error?: string }
export type CollaborationEvent =
  { type: 'agents_update'; agents: AgentSummary[] } | { type: 'agent_mailbox'; message: AgentMailboxMessage }

export type PendingInteraction = {
  sessionKey: string
  executionGeneration: number
  source: { agentId: string; name: string; rootSessionKey: string }
  request: PiExtensionDialogRequest
}

export interface CollaborationBridge {
  getAgents: (sessionKey: string) => Promise<AgentSummary[]>
  getAgentSnapshot: (agentId: string) => Promise<Snapshot>
  interruptAgent: (agentId: string) => Promise<void>
}
