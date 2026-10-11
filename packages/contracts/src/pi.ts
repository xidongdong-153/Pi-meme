import type { ImageContent, TextContent, ThinkingContent, ToolCall } from '@earendil-works/pi-ai'
import type { QueuedInput, TaskMode } from './plan'
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

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type PiImage = ImageContent
export type PiContent = TextContent | ThinkingContent | ImageContent | ToolCall
export type PiMessage = AgentSession['messages'][number]
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

export type PiState = Pick<
  RpcSessionState,
  'isStreaming' | 'isCompacting' | 'sessionName' | 'steeringMode' | 'followUpMode' | 'pendingMessageCount'
> & {
  isPaused?: boolean
  queuePaused?: boolean
  pauseRevision?: number
  pauseIntervals?: PiPauseInterval[]
  runIntervals?: PiRunInterval[]
  mode: TaskMode
  activeMode?: TaskMode
  model?: PiModel
  modelSelectionRequired?: boolean
  thinkingLevel?: ThinkingLevel
}
export type PiEvent =
  | (Extract<
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
      }
    > & { runIntervals?: PiRunInterval[] })
  | { type: 'agent_settled'; aborted?: boolean; runIntervals?: PiRunInterval[] }
  | {
      type: 'pause_update'
      isPaused: boolean
      queuePaused: boolean
      revision: number
      pauseIntervals?: PiPauseInterval[]
    }
  | { type: 'queue_update'; steering: QueuedInput[]; followUp: QueuedInput[] }
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

/** 正式消息按工具调用 ID 或角色与时间戳关联，快照与事件使用同一规则。 */
export function sameMessage(a: PiMessage, b: PiMessage): boolean {
  if (a.role === 'toolResult' || b.role === 'toolResult')
    return a.role === 'toolResult' && b.role === 'toolResult' && a.toolCallId === b.toolCallId
  return a.role === b.role && a.timestamp === b.timestamp
}
