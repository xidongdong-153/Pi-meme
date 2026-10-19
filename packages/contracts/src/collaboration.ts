import type { AgentAccessMode } from './agent-access'
import type { Snapshot } from './desktop'
import type { PiExtensionDialogRequest, PiModel, ThinkingLevel } from './pi'
import type { TaskMode } from './plan'

export const collaborationLimits = { activeChildren: 4, depth: 2, identities: 16 } as const
/** 顺序对应子代理头像资源；已有场景保留位置，新场景只追加。 */
export const agentAvatarScenes = [
  'general',
  'research',
  'plan',
  'code',
  'review',
  'test',
  'design',
  'docs',
  'frontend',
  'backend',
  'database',
  'devops',
  'security',
  'debug',
  'performance',
  'refactor',
  'browser',
  'data',
  'product',
  'localization',
] as const
export type AgentAvatarScene = (typeof agentAvatarScenes)[number]
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
  avatar?: AgentAvatarScene
  taskPath: string
  depth: number
}
export function resolveAgentTarget<T extends Pick<AgentIdentity, 'agentId' | 'taskPath'>>(
  agents: T[],
  caller: Pick<AgentIdentity, 'taskPath'>,
  target: string,
): T | undefined {
  const exact = agents.find((agent) => agent.agentId === target || agent.taskPath === target)
  if (exact) return exact
  const child = agents.find((agent) => agent.taskPath === `${caller.taskPath}/${target}`)
  if (child) return child
  const parentPath = caller.taskPath.slice(0, caller.taskPath.lastIndexOf('/'))
  return agents.find((agent) => agent.taskPath === `${parentPath}/${target}`)
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
  avatar?: AgentAvatarScene
  status?: AgentStatus
  startedAt?: string
  completedAt?: string
  text: string
  createdAt: string
}
export type CollaborationRequests = {
  spawn_agent: { task_name: string; message: string; avatar?: AgentAvatarScene; fork_turns?: 'all' | 'none' }
  send_message: { target: string; message: string }
  followup_task: { target: string; message: string }
  interrupt_agent: { target: string }
  list_agents: { path_prefix?: string }
  wait_agent: { targets?: string[]; timeout_ms?: number }
  finish_agent: { report: string }
}
export type CollaborationResults = {
  spawn_agent: AgentSummary
  send_message: { messageId: string; delivered: boolean }
  followup_task: { agent: AgentSummary; queued: boolean }
  interrupt_agent: { agent: AgentSummary; previousStatus: AgentStatus }
  list_agents: { agents: AgentSummary[] }
  wait_agent: { agents: AgentSummary[]; messages: AgentMailboxMessage[]; notifiedBy?: string[]; timedOut: boolean }
  finish_agent: { accepted: true }
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
