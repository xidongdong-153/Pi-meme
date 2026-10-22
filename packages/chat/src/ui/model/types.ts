import type { Goal } from '@pi-meme/contracts/goal'
import type { AgentMailboxMessage, AgentSummary } from '@pi-meme/contracts/collaboration'
import type { BranchSkillUsage } from '@pi-meme/contracts/skills'
import type { QueuedInput, PlanDocument } from '@pi-meme/contracts/plan'
import type { ChatBranchAttachment } from '@pi-meme/contracts/chat-attachments'
import type {
  PiImage,
  PiGenerationMetrics,
  PiMessage,
  PiPauseInterval,
  PiRunInterval,
  PiRetryState,
  PiState,
  PiSessionEntries,
  PiUiSource,
} from '@pi-meme/contracts/pi'

export type ToolRun = {
  id: string
  name: string
  parentToolCallId?: string
  source?: PiUiSource
  sourceEntry?: PiMessage['sourceEntry']
  children?: ToolRun[]
  args?: unknown
  result?: unknown
  status: 'running' | 'success' | 'error'
}
export type ChatCompactionState = {
  active: boolean
}

export type ChatState = {
  goal?: Goal
  goalsSupported?: boolean
  agents?: AgentSummary[]
  agentMessages?: AgentMailboxMessage[]
  planDocuments?: PlanDocument[]
  skillUsages?: BranchSkillUsage[]
  messages: PiMessage[]
  sessionEntries?: PiSessionEntries
  branchAttachments?: ChatBranchAttachment[]
  live: Extract<PiMessage, { role: 'assistant' }> | null
  stream: LiveStream
  tools: Record<string, ToolRun>
  paused?: boolean
  queuePaused?: boolean
  pauseRevision?: number
  pauseIntervals?: PiPauseInterval[]
  runIntervals?: PiRunInterval[]
  generationMetrics?: PiGenerationMetrics & { receivedAt: number }
  activeMode?: import('@pi-meme/contracts/plan').TaskMode
  running: boolean
  compacting: ChatCompactionState | null
  retry?: PiRetryState
  recovery?: PiState['recovery']
  compactionError?: string
  steering: readonly QueuedInput[]
  followUp: readonly QueuedInput[]
  /** 模型给出的下一步提示。空草稿时显示为占位，不进入消息列表。 */
  composerHint?: string
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
      sourceEntry?: PiMessage['sourceEntry']
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

export type AgentCollaborationStatus = {
  id: string
  afterActivityId?: string
  kind: 'wait' | 'feedback'
  status: 'running' | 'success' | 'inactive' | 'error'
  text: string
}

export type TurnChunk =
  | { type: 'custom'; message: Extract<PiMessage, { role: 'custom' }>; key: string }
  | {
      type: 'agent_status'
      phase: 'started' | 'finished'
      agents: Array<Pick<AgentSummary, 'agentId' | 'name' | 'avatar'>>
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
      collaboration?: AgentCollaborationStatus[]
      finalText: string
      sourceMessages?: PiMessage[]
      finalReplyMessages?: PiMessage[]
      images: Array<PiImage & { id?: string }>
      errorMessage?: string
      durationMs?: number
      /** 展示段起点，用于计算这一段的用时，不是分叉位置。 */
      startedAt?: number
      /** 打开这轮的用户消息时间。子代理状态、压缩和可见自定义消息只切展示段，分叉仍用它定位整轮。 */
      userTimestamp?: number
      /** 最终回复落定的本地时间。优先用完成时间，没有则用消息时间。 */
      repliedAt?: number
      /** 子代理详情把协作工具当成黑盒，只保留协作状态。 */
      hideAgentOperations?: boolean
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
