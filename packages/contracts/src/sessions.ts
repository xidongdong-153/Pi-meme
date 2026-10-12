import type { PiMessage, PiModel, PiSessionEntries, PiSessionStats, ThinkingLevel } from './pi'
import type { BranchSkillUsage } from './skills'
import type { SessionInfo } from '@earendil-works/pi-coding-agent'

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
    running?: boolean
    isPaused?: boolean
    error?: string
  }

export type PiProjectGroup = {
  cwd: string
  name: string
  sessionCount: number
  lastModified: string
  sessions: PiSessionSummary[]
}

export type PiSessionsSnapshot = {
  standaloneSessions?: PiSessionSummary[]
  recents: PiSessionSummary[]
  projects: PiProjectGroup[]
  pinnedPaths: string[]
  activeSessionId?: string
  activeSessionPath?: string
}

export type SessionHistoryData = {
  cwd: string
  created: string
  messages: PiMessage[]
  sessionEntries?: PiSessionEntries
  skillUsages?: BranchSkillUsage[]
  sessionName?: string
  /** 分叉来源会话文件路径，来自会话头部的 parentSession。 */
  parentSessionPath?: string
  model?: PiModel
  thinkingLevel?: ThinkingLevel
  stats?: PiSessionStats
}
