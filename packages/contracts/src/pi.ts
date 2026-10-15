import type { ImageContent, TextContent, ThinkingContent, ToolCall } from '@earendil-works/pi-ai'
import type { ResourceSnapshot } from './resources'
import type { QueuedInput, TaskMode } from './plan'
import type { BranchSkillUsage } from './skills'
import type { PiUserInputRequest, UserInputAnswer } from './user-input'
import type {
  AgentSession,
  JsonAgentSessionEvent,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcSessionState,
  SessionEntry,
  SessionStats,
  SlashCommandInfo,
  SourceInfo,
} from '@earendil-works/pi-coding-agent'

export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof thinkingLevels)[number]

export type PiImage = ImageContent
export type PiContent = TextContent | ThinkingContent | ImageContent | ToolCall
export type PiUiSource = { ownerId: string; generation: number; toolName?: string; customType?: string }
export type PiMessage = AgentSession['messages'][number] & { source?: PiUiSource; completedAt?: number }
type WithMessageMetadata<Event> = Event extends { message: PiMessage }
  ? Omit<Event, 'message'> & { message: PiMessage }
  : Event
export type PiSessionEntry = SessionEntry
export type PiBranchEntry = Pick<PiSessionEntry, 'id' | 'parentId' | 'timestamp' | 'type'> & {
  role?: PiMessage['role']
  messageTimestamp?: number
  customType?: string
  display?: boolean
  toolName?: string
  /** 单行摘要：消息正文预览、工具调用摘要或条目标记，供 Session Tree 阅读与搜索。 */
  preview?: string
}
export type PiSessionEntries = { entries: PiBranchEntry[]; leafId: string | null }
export type PiSlashCommand = {
  name: string
  displayName?: string
  shortDescription?: string
  builtin?: boolean
  resourceId?: string
  resourceRevision?: string
  invocation?: 'automatic' | 'manual'
  description?: SlashCommandInfo['description']
  source: SlashCommandInfo['source'] | 'builtin'
  sourceInfo: SourceInfo
}
/** `clearQueue` 返回被撤回的插话与排队消息，供界面恢复成草稿。 */
export type PiQueuedMessages = { steering: QueuedInput[]; followUp: QueuedInput[] }

export const builtinCommands: PiSlashCommand[] = [
  {
    name: 'plan',
    description: '切换规划模式；可在命令后填写任务',
    source: 'builtin',
    sourceInfo: { path: '', source: 'desktop', scope: 'temporary', origin: 'top-level' },
  },
  {
    name: 'compact',
    description: '压缩当前会话上下文，可在命令后填写压缩要求',
    source: 'builtin',
    sourceInfo: { path: '', source: 'desktop', scope: 'temporary', origin: 'top-level' },
  },
  {
    name: 'name',
    description: '重命名当前会话：/name <会话名称>',
    source: 'builtin',
    sourceInfo: { path: '', source: 'desktop', scope: 'temporary', origin: 'top-level' },
  },
]

export function builtinCommand(message: string) {
  const match = message.trim().match(/^\/(compact|name)(?:\s([\s\S]*))?$/)
  return match ? { name: match[1], args: match[2]?.trim() || undefined } : null
}
export type PiModel = { provider: string; id: string; name?: string; reasoning?: boolean }
export type PiSessionStats = SessionStats
export type PiRunInterval = { startedAt: number; endedAt?: number }
export type PiPauseInterval = { startedAt: number; endedAt?: number }
export type PiRetryState = {
  kind: 'model' | 'summary'
  attempt: number
  maxAttempts: number
  delayMs: number
  errorMessage: string
}

export type PiState = Pick<
  RpcSessionState,
  'isStreaming' | 'isCompacting' | 'sessionName' | 'steeringMode' | 'followUpMode' | 'pendingMessageCount'
> & {
  isPaused?: boolean
  queuePaused?: boolean
  pauseRevision?: number
  pauseIntervals?: PiPauseInterval[]
  runIntervals?: PiRunInterval[]
  retry?: PiRetryState
  compactionError?: string
  mode: TaskMode
  activeMode?: TaskMode
  skillUsages?: BranchSkillUsage[]
  resourceSnapshot?: ResourceSnapshot
  /** 输入框下一步提示。不写入会话 JSONL，只随状态快照恢复。 */
  composerHint?: string
  model?: PiModel
  modelSelectionRequired?: boolean
  thinkingLevel?: ThinkingLevel
}
export type PiEvent =
  | (WithMessageMetadata<
      Extract<
        JsonAgentSessionEvent,
        {
          type:
            | 'agent_start'
            | 'agent_end'
            | 'message_start'
            | 'message_update'
            | 'message_end'
            | 'tool_execution_start'
            | 'tool_execution_update'
            | 'tool_execution_end'
            | 'compaction_start'
            | 'compaction_end'
            | 'auto_retry_start'
            | 'auto_retry_end'
            | 'summarization_retry_scheduled'
            | 'summarization_retry_attempt_start'
            | 'summarization_retry_finished'
        }
      >
    > & { runIntervals?: PiRunInterval[]; source?: PiUiSource })
  | { type: 'agent_settled'; aborted?: boolean; runIntervals?: PiRunInterval[] }
  | {
      type: 'pause_update'
      isPaused: boolean
      queuePaused: boolean
      revision: number
      pauseIntervals?: PiPauseInterval[]
    }
  | { type: 'queue_update'; steering: QueuedInput[]; followUp: QueuedInput[] }
  | { type: 'skill_usage_update'; usages: BranchSkillUsage[] }
  | { type: 'composer_hint'; text?: string }
export type PiExtensionDialogRequest =
  Extract<RpcExtensionUIRequest, { method: 'select' | 'confirm' | 'input' | 'editor' }> | PiUserInputRequest
export type PiExtensionEvent =
  | RpcExtensionUIRequest
  | PiUserInputRequest
  | { type: 'extension_ui_timeout'; id: string }
  | { type: 'extension_ui_closed'; id: string; reason: 'answered' | 'cancelled' }
export type PiExtensionError = { type: 'extension_error'; extensionPath: string; event: string; error: string }
type ResponsePayload<T> = T extends unknown ? Omit<T, 'type' | 'id'> : never
export type PiExtensionUIResponse = ResponsePayload<RpcExtensionUIResponse> | { answers: UserInputAnswer[] }

/** 协作消息按消息 ID 关联，避免落盘时间与实时事件时间不同而重复显示。 */
export function sameMessage(a: PiMessage, b: PiMessage): boolean {
  if (a.role === 'toolResult' || b.role === 'toolResult')
    return a.role === 'toolResult' && b.role === 'toolResult' && a.toolCallId === b.toolCallId
  if (
    a.role === 'custom' &&
    b.role === 'custom' &&
    a.customType === 'pi-meme-collaboration' &&
    b.customType === 'pi-meme-collaboration'
  ) {
    const aId = (a.details as { messageId?: unknown } | undefined)?.messageId
    const bId = (b.details as { messageId?: unknown } | undefined)?.messageId
    if (typeof aId === 'string' && aId && typeof bId === 'string' && bId) return aId === bId
  }
  return a.role === b.role && a.timestamp === b.timestamp
}
