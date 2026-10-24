import type { ServiceActivity, ServiceActivityList, ServiceActivityLogs } from './service-activity'
import type { Goal, GoalControl, GoalEdit, GoalInput, GoalResumeControl, GoalStartResult } from './goal'
import type { AgentAccessMode } from './agent-access'
import type { AgentSummary } from './collaboration'
import type { GitEnvironment, GitSnapshot, GitFileChange, Snapshot } from './desktop'
import type { ThinkingLevel } from './pi'
import type { PlanDocument, TaskMode } from './plan'
import type { SessionHistoryData } from './sessions'
import type { SkillReference } from './skills'
import type { UiMessage, UiMessagePage, UiMessagePageInput } from './plugin-ui-data'

export const appHostApiVersion = 2 as const
export type ProjectRef = { hostId: string; projectId: string }
export type SessionRef = { hostId: string; sessionId: string }
export type WorkspaceRef = ProjectRef | SessionRef
export type AppProject = ProjectRef & { cwd: string; name: string; unavailable?: boolean }
export type AppModel = { provider: string; id: string; name?: string; reasoning?: boolean }
export type AppImage = { type: 'image'; data: string; mimeType: string }
export type InteractionAnswer =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }
  | { answers: Array<{ id: string; value: string | null }> }
export type SessionConfiguration = {
  agentPlugins?: string[]
  model?: AppModel
  thinkingLevel?: ThinkingLevel
  accessMode?: AgentAccessMode
  mode?: TaskMode
}
export type AppSession = SessionRef & {
  project?: ProjectRef
  cwd: string
  createdAt: string
  name?: string
  sessionFile?: string
  configuration: SessionConfiguration
  status: 'idle' | 'running' | 'interrupted'
}
export type MutationOptions = { idempotencyKey: string }
export type SubmissionInput = {
  delivery: 'start' | 'queue' | 'steer'
  text: string
  images?: AppImage[]
  skills?: SkillReference[]
  mode?: TaskMode
}
export type SubmissionReceipt = {
  operationId: string
  submissionId: string
  session: SessionRef
  delivery: SubmissionInput['delivery']
  status: 'accepted' | 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
  runId?: string
  error?: string
  dispatchStartedAt?: string
  outcomeUncertain?: boolean
}
export type FileEntry = { name: string; relativePath: string; kind: 'file' | 'directory'; size: number }
export type FileContent = { relativePath: string; content: string }
export type FilePreview =
  | (FileContent & { kind: 'text'; revision: string })
  | { kind: 'image'; relativePath: string; dataUrl: string; size: number }
  | { kind: 'unsupported'; relativePath: string; reason: 'binary' | 'too-large' | 'encoding' }
export type FileSearchResult = { entries: FileEntry[]; nextCursor?: string }
export type FileWriteInput = FileContent & { revision: string }
export type TerminalRef = { hostId: string; terminalId: string }
export type TerminalSnapshot = TerminalRef & {
  cwd: string
  cols: number
  rows: number
  output: string
  outputSequence: number
  exited: boolean
  exitCode?: number
}
export type AppHostCapabilities = {
  apiVersion: 2
  hostId: string
  features: Array<
    | 'projects'
    | 'sessions'
    | 'messages'
    | 'files'
    | 'terminal'
    | 'git'
    | 'interaction'
    | 'agents'
    | 'plans'
    | 'goals'
    | 'activities'
  >
  fileOperations?: Array<'preview' | 'search' | 'write'>
}
export type EventCursor = { journalEpoch: string; seq: number }
export type HostControlEvent = EventCursor & {
  stream?: 'live'
  eventId: string
  hostId: string
  timestamp: string
  projectId?: string
  sessionId?: string
  type: 'session' | 'submission' | 'runtime' | 'terminal' | 'activity' | 'resync'
  value:
    | AppSession
    | SubmissionReceipt
    | Snapshot['connection']
    | { terminalId: string; data?: string; outputSequence?: number; exitCode?: number }
    | { reason: string }
    | Snapshot['messages'][number]
    | Record<string, unknown>
}
export type EventFilter = { projectId?: string; sessionId?: string; terminalId?: string }
export type EventPage = { events: HostControlEvent[]; cursor: EventCursor; resyncRequired: boolean }
export type EventSubscription = EventFilter & { after?: EventCursor }
export type HostApi = {
  readonly apiVersion: 2
  capabilities: () => Promise<AppHostCapabilities>
  plugins: {
    getDefaultAgentPlugins: () => Promise<string[]>
    setDefaultAgentPlugins: (ids: string[], options: MutationOptions) => Promise<string[]>
  }
  projects: {
    list: () => Promise<AppProject[]>
    register: (input: { cwd: string; name?: string }, options: MutationOptions) => Promise<AppProject>
    get: (ref: ProjectRef) => Promise<AppProject>
  }
  sessions: {
    create: (
      input: { project?: ProjectRef; configuration?: SessionConfiguration; name?: string },
      options: MutationOptions,
    ) => Promise<AppSession>
    list: (input?: { project?: ProjectRef }) => Promise<AppSession[]>
    get: (ref: SessionRef) => Promise<AppSession>
    snapshot: (ref: SessionRef) => Promise<Snapshot & { controlCursor: EventCursor }>
    history: (
      ref: SessionRef,
      input?: { offset?: number; limit?: number },
    ) => Promise<SessionHistoryData & { totalMessages: number; nextOffset?: number }>
    messages: (ref: SessionRef, input?: UiMessagePageInput) => Promise<UiMessagePage>
    message: (ref: SessionRef, input: { entryId: string }) => Promise<UiMessage>
    configure: (ref: SessionRef, configuration: SessionConfiguration, options: MutationOptions) => Promise<AppSession>
    submit: (ref: SessionRef, input: SubmissionInput, options: MutationOptions) => Promise<SubmissionReceipt>
    stop: (ref: SessionRef, options: MutationOptions) => Promise<void>
    stopTask: (ref: SessionRef, options: MutationOptions) => Promise<void>
    continueTask: (
      ref: SessionRef,
      configuration: import('./plan').MessageConfiguration | undefined,
      options: MutationOptions,
    ) => Promise<void>
    pause: (ref: SessionRef, options: MutationOptions) => Promise<void>
    resume: (ref: SessionRef, options: MutationOptions) => Promise<void>
    receipt: (operationId: string) => Promise<SubmissionReceipt>
    submissions: (ref: SessionRef) => Promise<SubmissionReceipt[]>
    cancelSubmission: (operationId: string, options: MutationOptions) => Promise<void>
  }
  events: {
    read: (input?: EventSubscription) => Promise<EventPage>
    subscribe: (input: EventSubscription, listener: (event: HostControlEvent) => void) => Promise<() => void>
  }
  files: {
    list: (root: WorkspaceRef, relativePath?: string) => Promise<FileEntry[]>
    read: (root: WorkspaceRef, relativePath: string) => Promise<FileContent>
    preview: (root: WorkspaceRef, relativePath: string) => Promise<FilePreview>
    search: (root: WorkspaceRef, input: { query: string; cursor?: string }) => Promise<FileSearchResult>
    write: (root: WorkspaceRef, input: FileWriteInput, options: MutationOptions) => Promise<{ revision: string }>
  }
  terminal: {
    open: (
      root: WorkspaceRef,
      input: { command?: string; cols?: number; rows?: number },
      options: MutationOptions,
    ) => Promise<TerminalSnapshot>
    attach: (ref: TerminalRef) => Promise<TerminalSnapshot>
    input: (ref: TerminalRef, data: string, options: MutationOptions) => Promise<void>
    resize: (ref: TerminalRef, size: { cols: number; rows: number }, options: MutationOptions) => Promise<void>
    close: (ref: TerminalRef, options: MutationOptions) => Promise<void>
  }
  git: {
    environment: (root: WorkspaceRef) => Promise<GitEnvironment>
    snapshot: (root: WorkspaceRef) => Promise<GitSnapshot>
    diff: (
      root: WorkspaceRef,
      input: { path: string; staged?: boolean; kind?: GitFileChange['kind'] },
    ) => Promise<string>
  }
  interaction: {
    respond: (
      ref: SessionRef,
      input: { requestId: string; response: InteractionAnswer; agentId?: string },
      options: MutationOptions,
    ) => Promise<void>
  }
  agents: {
    list: (ref: SessionRef) => Promise<AgentSummary[]>
    get: (agentId: string) => Promise<Snapshot>
    stop: (agentId: string, options: MutationOptions) => Promise<void>
  }
  goals: {
    get: (ref: SessionRef) => Promise<Goal | undefined>
    start: (ref: SessionRef, input: GoalInput, options: MutationOptions) => Promise<GoalStartResult>
    edit: (ref: SessionRef, input: GoalEdit, options: MutationOptions) => Promise<Goal>
    pause: (ref: SessionRef, input: GoalControl, options: MutationOptions) => Promise<Goal>
    resume: (ref: SessionRef, input: GoalResumeControl, options: MutationOptions) => Promise<Goal>
    clear: (ref: SessionRef, input: GoalControl, options: MutationOptions) => Promise<void>
  }
  activities: {
    list: (ref: SessionRef) => Promise<ServiceActivityList>
    logs: (ref: SessionRef, serviceId: string) => Promise<ServiceActivityLogs>
    stop: (ref: SessionRef, serviceId: string, options: MutationOptions) => Promise<ServiceActivity>
  }
  plans: { list: (ref: SessionRef) => Promise<PlanDocument[]> }
}
export type HostControlRequest = {
  hostId?: string
  apiVersion: 2
  clientId: string
  method: string
  args: unknown[]
  idempotencyKey?: string
}
export type HostControlResponse = { hostId: string; result?: unknown; error?: { code: string; message: string } }
