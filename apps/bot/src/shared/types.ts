export type TaskStatus =
  'queued' | 'running' | 'waiting' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'unknown' | 'blocked'
export type Capability = 'collaborate' | 'hosts' | 'images' | 'web' | 'schedules'
export interface Resource {
  id: string
  revision: number
  createdAt: string
  updatedAt: string
}
export interface Bot extends Resource {
  name: string
  avatar: string
  description: string
  instructions: string
  modelId: string
  enabled: boolean
  capabilities: Capability[]
  collaboratorIds: string[]
  hostIds: string[]
  maxToolCalls: number
  webConversationId?: string
}
export interface ModelConfig extends Resource {
  name: string
  kind: 'text' | 'image'
  provider: 'openai' | 'anthropic' | 'google' | 'openai-compatible'
  model: string
  baseUrl: string
  credentialRef?: string
  hasCredential?: boolean
}
export interface Conversation extends Resource {
  name: string
  kind: 'direct' | 'group' | 'qq'
  memberIds: string[]
  coordinatorId: string
  memberSince: Record<string, number>
  pinned: boolean
  archived: boolean
  sequence: number
  qqUserId?: string
  qqAppId?: string
}
export interface Message extends Resource {
  conversationId: string
  sequence: number
  role: 'user' | 'assistant' | 'system'
  content: string
  botId?: string
  authorName: string
  avatar?: string
  taskId?: string
  sourceMessageId?: string
  assistantEntryId?: string
  platformMessageId?: string
  attachmentIds: string[]
  source: 'web' | 'api' | 'qq' | 'schedule'
  recipientIds?: string[]
}
export interface HostDelegation {
  hostId: string
  projectId: string
  sessionId?: string
  operationId?: string
  submissionId?: string
  runId?: string
  idempotencyKey: string
  status: string
  result?: string
  lastSyncedAt?: string
  cursor?: { journalEpoch: string; seq: number }
}
export interface Task extends Resource {
  conversationId: string
  sourceMessageId: string
  botId: string
  parentTaskId?: string
  previousTaskId?: string
  status: TaskStatus
  prompt: string
  result?: string
  error?: string
  runtimeId?: string
  submissionId?: string
  config: Bot
  attachmentIds: string[]
  toolCalls: number
  hostDelegation?: HostDelegation
  usage?: { input: number; output: number; cost: number | null }
  stopRequested?: boolean
  publicReply: boolean
  depth: number
  startedAt?: string
  finishedAt?: string
  notification?: 'web' | 'qq'
  modelConfig?: ModelConfig
  mode?: 'queue' | 'steer'
  contextThroughSequence?: number
}
export interface HostConnection extends Resource {
  name: string
  url: string
  credentialRef?: string
  hasCredential?: boolean
  expectedHostId?: string
  projectIds: string[]
  status: 'unchecked' | 'online' | 'offline' | 'identity-changed'
  error?: string
  checkedAt?: string
  capabilities?: string[]
}
export interface QqConfig {
  revision: number
  enabled: boolean
  appId: string
  credentialRef?: string
  hasCredential?: boolean
  defaultBotId: string
  boundUserId?: string
  bindingCodeHash?: string
  bindingExpiresAt?: string
  status: 'disabled' | 'connecting' | 'online' | 'offline'
  error?: string
  sessionId?: string
  gatewaySequence?: number
  lastEventAt?: string
}
export interface Schedule extends Resource {
  name: string
  conversationId: string
  botId: string
  prompt: string
  enabled: boolean
  kind: 'once' | 'daily' | 'weekly'
  timezone: string
  at: string
  time: string
  weekdays: number[]
  nextRunAt?: string
  lastRunAt?: string
  activeTaskId?: string
  notification: 'web' | 'qq'
}
export interface ScheduleRun extends Resource {
  scheduleId: string
  dueAt: string
  status: 'running' | 'completed' | 'failed' | 'skipped'
  taskIds: string[]
  error?: string
  scheduleRevision?: number
  scheduleSnapshot?: Schedule
}
export interface Memory extends Resource {
  scope: 'owner' | 'bot' | 'conversation'
  targetId?: string
  title: string
  content: string
  sourceMessageId?: string
}
export interface Attachment extends Resource {
  name: string
  mime: string
  size: number
  sha256: string
  objectName: string
  conversationId?: string
  taskId?: string
  generationId?: string
  source: 'upload' | 'image' | 'host'
}
export interface Generation extends Resource {
  taskId?: string
  conversationId: string
  modelId: string
  prompt: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'unknown'
  attachmentIds: string[]
  error?: string
  cost: number | null
  providerJobId?: string
  previousGenerationId?: string
  modelSnapshot?: { provider: string; model: string; baseUrl: string }
}
export interface Delivery extends Resource {
  messageId: string
  conversationId: string
  channel: 'qq'
  targetUserId: string
  appId: string
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'blocked'
  attempts: number
  platformMessageId?: string
  error?: string
  replyMessageId?: string
  mediaInfo?: string
  mediaExpiresAt?: string
  attachmentId?: string
  partIndex?: number
  replySequence?: number
}
export interface ApiToken extends Resource {
  name: string
  hash: string
  prefix: string
  scopes: ('read' | 'write')[]
  revokedAt?: string
}
export interface WebSession {
  hash: string
  expiresAt: string
  credentialGeneration: number
}
export interface AppEvent {
  id: string
  seq: number
  type: string
  resourceId?: string
  time: string
}
export interface Operation {
  hash: string
  result: unknown
  createdAt: string
}
export interface AppState {
  schemaVersion: number
  epoch: string
  seq: number
  ownerPasswordHash?: string
  credentialGeneration: number
  bots: Record<string, Bot>
  models: Record<string, ModelConfig>
  conversations: Record<string, Conversation>
  messages: Record<string, Message>
  tasks: Record<string, Task>
  hosts: Record<string, HostConnection>
  qq: QqConfig
  schedules: Record<string, Schedule>
  scheduleRuns: Record<string, ScheduleRun>
  memories: Record<string, Memory>
  attachments: Record<string, Attachment>
  generations: Record<string, Generation>
  deliveries: Record<string, Delivery>
  tokens: Record<string, ApiToken>
  sessions: Record<string, WebSession>
  operations: Record<string, Operation>
  inboundIds: Record<string, string>
  events: AppEvent[]
  settings: { webEnabled: boolean; allowedWebDomains: string[]; reducedMotion: boolean }
}
export interface MessageInput {
  conversationId: string
  content: string
  attachmentIds?: string[]
  recipientIds?: string[]
  source: 'web' | 'api' | 'qq' | 'schedule'
  requestId: string
  mode?: 'queue' | 'steer'
  notification?: 'web' | 'qq'
  platformMessageId?: string
}
export interface AcceptedMessage {
  messageId: string
  taskIds: string[]
  status: 'accepted'
}
export interface CapabilityState {
  available: boolean
  reason?: string
}
export interface Snapshot {
  bots: Bot[]
  models: ModelConfig[]
  conversations: Conversation[]
  tasks: Task[]
  hosts: HostConnection[]
  qq: QqConfig
  schedules: Schedule[]
  scheduleRuns: ScheduleRun[]
  memories: Memory[]
  attachments: Attachment[]
  generations: Generation[]
  deliveries: Delivery[]
  tokens: Omit<ApiToken, 'hash'>[]
  settings: AppState['settings']
  cursor: string
  capabilities: Record<string, CapabilityState>
}
export interface ApiError {
  error: { code: string; message: string; retryable: boolean; requestId: string; details?: unknown }
}
