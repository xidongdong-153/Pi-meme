import type { PiMessage, PiModel, PiRecoveryState, PiSessionEntries, PiSessionStats, ThinkingLevel } from './pi'
import type { ChatBranchAttachment } from './chat-attachments'
import type { BranchSkillUsage } from './skills'
import type { QueuedInput, PlanCheckpoint } from './plan'
import type { SessionInfo } from '@earendil-works/pi-coding-agent'
import type { ScheduledTask } from './schedules'

export type SessionReadObservation = { completionToken?: string; inputRequestIds?: string[] }

/** Host 统一保存的查看状态；token 只确认对应正文版本，不确认之后的新内容。 */
export type SessionAttention = {
  session: import('./app-host').SessionRef
  revision: number
  completionToken?: string
  completionSource?: { id: string; revision: string }
  inputRequestIds: string[]
  unread: boolean
  inputUnread: boolean
}

export type WorkspaceKind = 'project' | 'standalone'

export type SelectWorkspace = { kind: 'project'; cwd: string } | { kind: 'standalone' }

export type DesktopProject = {
  cwd: string
  name: string
  lastSelectedAt: string
  unavailable?: boolean
}

export type PiSessionSummary = Pick<SessionInfo, 'id' | 'path' | 'cwd' | 'name' | 'messageCount'> &
  Partial<Pick<SessionInfo, 'firstMessage' | 'parentSessionPath'>> & {
    workspaceKind?: WorkspaceKind
    sourceProjectCwd?: string
    created: string
    modified: string
    completedAt?: string | null
    completionSource?: { id: string; revision: string }
    attention?: SessionAttention
    running?: boolean
    needsInput?: boolean
    /** 待答交互的真实来源、执行代次与请求 ID，用于向 Host 按次确认已查看。 */
    inputRequestIds?: string[]
    inputUnread?: boolean
    /** Host 共享的未读状态，不写入会话文件。 */
    unread?: boolean
    isPaused?: boolean
    error?: string
    scheduledTask?: Pick<ScheduledTask, 'taskId' | 'name' | 'status' | 'nextRunAt'> & { timeZone: string }
    temporary?: boolean
  }

export type PiProjectGroup = {
  cwd: string
  name: string
  sessionCount: number
  lastModified: string
  sessions: PiSessionSummary[]
}

export type PiSessionsSnapshot = {
  attentionRevision?: number
  standaloneSessions?: PiSessionSummary[]
  recents: PiSessionSummary[]
  projects: PiProjectGroup[]
  pinnedPaths: string[]
  activeSessionId?: string
  activeSessionPath?: string
}

export type SessionSearchMatch = { path: string; excerpt: string }

export type SessionWindow = { limit: number; before?: string; from?: string; details?: 'deferred' }
export type SessionMessagePage = { before: string }

export type SessionHistoryData = {
  visualizationReferences?: import('./visualize').VisualizationRef[]
  historyRevision?: string
  historyDetails?: 'complete' | 'deferred'
  /** 全量投影的存在性摘要，详情分页不会清除此字段。 */
  historyAvailability?: { tree: boolean; sources: boolean }
  totalMessages?: number
  cwd: string
  created: string
  messages: PiMessage[]
  messagePage?: SessionMessagePage
  planCheckpoints?: PlanCheckpoint[]
  sessionEntries?: PiSessionEntries
  skillUsages?: BranchSkillUsage[]
  recovery?: PiRecoveryState
  taskControl?: { stopped: boolean; steering: QueuedInput[]; followUp: QueuedInput[] }
  sessionName?: string
  /** 分叉来源会话文件路径，来自会话头部的 parentSession。 */
  parentSessionPath?: string
  model?: PiModel
  thinkingLevel?: ThinkingLevel
  stats?: PiSessionStats
  branchAttachments?: ChatBranchAttachment[]
}
