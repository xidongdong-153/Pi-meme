import type { AgentMailboxMessage, AgentSummary } from '@pi-meme/contracts/collaboration'
import type { BranchSkillUsage } from '@pi-meme/contracts/skills'
import type { QueuedInput, PlanDocument } from '@pi-meme/contracts/plan'
import type {
  PiImage,
  PiMessage,
  PiPauseInterval,
  PiRunInterval,
  PiRetryState,
  PiSessionEntries,
  PiUiSource,
} from '@pi-meme/contracts/pi'

export type ToolRun = {
  id: string
  name: string
  parentToolCallId?: string
  source?: PiUiSource
  children?: ToolRun[]
  args?: unknown
  result?: unknown
  status: 'running' | 'success' | 'error'
}
export type ChatCompactionState = {
  active: boolean
}

export type ChatState = {
  agents?: AgentSummary[]
  agentMessages?: AgentMailboxMessage[]
  planDocuments?: PlanDocument[]
  skillUsages?: BranchSkillUsage[]
  messages: PiMessage[]
  sessionEntries?: PiSessionEntries
  live: Extract<PiMessage, { role: 'assistant' }> | null
  stream: LiveStream
  tools: Record<string, ToolRun>
  paused?: boolean
  queuePaused?: boolean
  pauseRevision?: number
  pauseIntervals?: PiPauseInterval[]
  runIntervals?: PiRunInterval[]
  activeMode?: import('@pi-meme/contracts/plan').TaskMode
  running: boolean
  compacting: ChatCompactionState | null
  retry?: PiRetryState
  compactionError?: string
  steering: readonly QueuedInput[]
  followUp: readonly QueuedInput[]
}

export type LiveStream = { arguments: Record<number, string>; completed: Record<number, boolean> }
export type ActivityItem =
  | {
      id: string
      type: 'thinking'
      thinking: string
      status?: 'running' | 'success'
    }
  | {
      id: string
      type: 'narration'
      text: string
      status?: 'success'
    }
  | {
      id: string
      type?: 'tool'
      source?: PiUiSource
      name?: string
      children?: ToolRun[]
      command?: string
      output?: string
      args?: unknown
      result?: unknown
      status?: 'running' | 'success' | 'error'
    }

export type ActionItemData = ActivityItem

export type RenderSegment = { type: 'text'; text: string } | { type: 'activity'; items: ActivityItem[] }

export type TurnChunk =
  | { type: 'custom'; message: Extract<PiMessage, { role: 'custom' }>; key: string }
  | {
      type: 'agent_status'
      phase: 'started' | 'finished'
      agents: Array<{ agentId: string; name: string }>
      status: '开始工作' | '已完成' | '失败' | '已中断' | '已停止' | '已结束'
      timestamp: number
      key: string
    }
  | {
      type: 'user'
      message: PiMessage
      key: string
    }
  | {
      type: 'assistant_turn'
      activities: ActivityItem[]
      finalText: string
      images: Array<PiImage & { id?: string }>
      errorMessage?: string
      durationMs?: number
      startedAt?: number
      isLive: boolean
      key: string
    }
  | {
      type: 'compaction'
      kind: 'compaction' | 'branch_summary'
      summary: string
      tokensBefore?: number
      timestamp?: number
      key: string
    }

export type ConversationOutlineEntry = {
  key: string
  turnIndex: number
  title: string
  preview: string
}
