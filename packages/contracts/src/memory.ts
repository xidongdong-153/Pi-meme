import type { MutationOptions, SessionRef } from './app-host'
import type { AgentAccessMode } from './agent-access'
import type { TaskMode } from './plan'

export type MemoryScope = { kind: 'global' } | { kind: 'project'; projectId: string }
export type MemoryModel = { provider: string; id: string }
export type MemoryConfig = {
  enabled: boolean
  autoLearn: boolean
  model: MemoryModel | null
  dailyTokenBudget: number
  revision: number
}
export type MemorySource = {
  id: string
  session: SessionRef
  entryId: string
  revision: string
  excerpt: string
}
export type MemoryEntry = {
  id: string
  title: string
  content: string
  scope: MemoryScope
  origin: 'manual' | 'auto'
  locked: boolean
  revision: number
  sources: MemorySource[]
  createdAt: string
  updatedAt: string
}
export type MemoryEntryInput = Pick<MemoryEntry, 'title' | 'content' | 'scope'>
export type MemoryQuery = { query?: string; scope?: MemoryScope; cursor?: string; limit?: number }
export type MemoryPage = { entries: MemoryEntry[]; nextCursor?: string; revision: number }
export type MemoryJobState =
  'waiting' | 'extracting' | 'consolidating' | 'completed' | 'failed' | 'cancelled' | 'budget-paused' | 'interrupted'
export type MemoryJob = {
  id: string
  session: SessionRef
  projectId: string
  state: MemoryJobState
  createdAt: string
  updatedAt: string
  error?: string
  tokens: number
  unknownUsage: boolean
}
export type MemoryStatus = {
  config: MemoryConfig
  revision: number
  epoch: number
  totalEntries: number
  jobs: MemoryJob[]
  budget: { date: string; tokens: number; reserved: number; calls: number; unknownCalls: number }
  error?: string
}
export type MemoryApi = {
  status: () => Promise<MemoryStatus>
  configure: (
    patch: Partial<Omit<MemoryConfig, 'revision'>>,
    revision: number,
    options: MutationOptions,
  ) => Promise<MemoryStatus>
  list: (query?: MemoryQuery) => Promise<MemoryPage>
  get: (id: string) => Promise<MemoryEntry>
  create: (input: MemoryEntryInput, epoch: number, options: MutationOptions) => Promise<MemoryEntry>
  update: (id: string, input: MemoryEntryInput, revision: number, options: MutationOptions) => Promise<MemoryEntry>
  remove: (id: string, revision: number, options: MutationOptions) => Promise<void>
  clear: (revision: number, options: MutationOptions) => Promise<MemoryStatus>
  stop: (jobId: string, options: MutationOptions) => Promise<void>
  retry: (jobId: string, options: MutationOptions) => Promise<void>
}
export type MemorySnapshot = {
  enabled: boolean
  epoch: number
  scopeRevision: string
  content: string
  entryIds: string[]
}
export type MemoryRuntimeRequest =
  { kind: 'snapshot'; query: string } | { kind: 'admit'; epoch: number; scopeRevision: string; hasMemory: boolean }
export type MemoryRuntimeResult = MemorySnapshot | { allowed: boolean }
export type MemoryRuntimeBridge = (request: MemoryRuntimeRequest, signal?: AbortSignal) => Promise<MemoryRuntimeResult>

/** Only Host-issued tickets authorize learning; copied or imported history is not a new source. */
export type MemoryTurnTicket = {
  id: string
  epoch: number
  learningEpoch: number
  sequence: number
  session: SessionRef
  projectId: string
  model: MemoryModel
  startedAt: string
}
export type MemoryTurnInput = {
  session: SessionRef
  projectId: string
  model: MemoryModel
  mode: TaskMode
  accessMode: AgentAccessMode
  eligible: boolean
}
export type MemoryLearningSource = {
  source: MemorySource
  role: 'user' | 'assistant'
  text: string
}
export type MemoryModelResult = {
  text: string
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number }
  cost?: number
}
export type MemoryUsageRecord = {
  attemptId: string
  purpose: 'memory.extract' | 'memory.consolidate'
  model: MemoryModel
  timestamp: string
  outcome: 'completed' | 'failed' | 'unknown'
  tokens?: number
  cost?: number
}
export type MemoryServiceOptions = {
  directory: string
  hostId: string
  complete: (input: {
    model: MemoryModel
    system: string
    prompt: string
    maxTokens: number
    signal: AbortSignal
  }) => Promise<MemoryModelResult>
  recordUsage: (record: MemoryUsageRecord) => Promise<void>
  validateProject: (projectId: string) => boolean | Promise<boolean>
  validateSources?: (sources: MemorySource[]) => boolean | Promise<boolean>
  onChanged: () => void
  onError: (cause: unknown) => void
  now?: () => number
  idleMs?: number
  /** null means busy; a timestamp is the latest activity/end, and 0 means unknown historical activity. */
  sessionIdleSince?: (session: SessionRef) => number | null | Promise<number | null>
}
