import type { ProjectRef, SessionRef } from './app-host'
import type { AgentAccessMode } from './agent-access'
import type { TaskMode } from './plan'

export type UiJsonValue = null | boolean | number | string | UiJsonValue[] | { [key: string]: UiJsonValue }
export type UiTarget = { hostId: string; project?: ProjectRef; session?: SessionRef }
/** 只引用原生 message/custom_message，不为压缩或分支摘要生成引用。 */
export type MessageRef = { session: SessionRef; entryId: string }
export type UiMessageRole = 'user' | 'assistant' | 'tool' | 'custom'
export type UiMessageSource = {
  ownerId: string
  generation: number
  policyHash?: string
  toolName?: string
  customType?: string
}
export type UiMessageMetadata = {
  id: string
  ref?: MessageRef
  role: UiMessageRole
  timestamp?: number
  completedAt?: number
  revision: string
  state: 'streaming' | 'complete' | 'error' | 'aborted'
  source?: UiMessageSource
  toolCallId?: string
  toolName?: string
  customType?: string
}
export type UiMessageImage = { index: number; mimeType: string; ref?: { message: MessageRef; index: number } }
export type UiMessageBody = {
  text: string
  data?: UiJsonValue
  images: UiMessageImage[]
}
export type UiMessage = UiMessageMetadata & UiMessageBody
export type UiMessagePageInput = { offset?: number; limit?: number; cursor?: string }
export type UiMessagePage = {
  messages: UiMessage[]
  totalMessages: number
  nextOffset?: number
  nextCursor?: string
  branchRevision: string
  leafId: string | null
}
export type UiSessionMetadata = {
  status: string
  running: boolean
  agentPlugins: readonly string[]
  mode?: TaskMode
  accessMode?: AgentAccessMode
  paused?: boolean
  queuePaused?: boolean
  requestedMode?: TaskMode
  effectiveMode?: TaskMode
  requestedAccess?: AgentAccessMode
  effectiveAccess?: AgentAccessMode
  capabilities?: readonly string[]
  deniedReasons?: Readonly<Record<string, string>>
  policyRevision?: string
  model?: { provider: string; id: string; name?: string }
  thinkingLevel?: string
  runId?: string
  queue?: { steering: number; followUp: number }
  usage?: { input: number; output: number; total: number; estimated: boolean }
  generation?: { outputTokens: number; elapsedMs: number; phase: string; estimated: boolean }
  selectedPlugins?: readonly string[]
  effectivePlugins?: readonly { id: string; generation?: number }[]
  unavailablePlugins?: readonly { id: string; reason: string }[]
}
export type UiReactiveMetadata = {
  target: UiTarget
  targetEpoch?: number
  view?: { kind: 'chat' } | { kind: 'plugin'; pluginId: string; pageId: string; target: UiTarget }
  connection?: { status: string; error?: string }
  session: UiSessionMetadata | null
}
export type UiReactiveState = UiReactiveMetadata & { messages: readonly UiMessageMetadata[] }
export type UiMessageActionSubject = {
  role: UiMessageRole
  refs: readonly MessageRef[]
  displayedText: string
  state: UiMessageMetadata['state']
  revision: string
  source?: UiMessageSource
  toolCallId?: string
  toolName?: string
  customType?: string
}

/** 只用于已脱离业务对象的新投影，避免一个消费者改坏其他消费者的快照。 */
export function freezeUiValue<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeUiValue(child)
    Object.freeze(value)
  }
  return value
}

export function messageRefKey(ref: MessageRef): string {
  return JSON.stringify([ref.session.hostId, ref.session.sessionId, ref.entryId])
}

export function sameUiTarget(a: UiTarget, b: UiTarget): boolean {
  return (
    a.hostId === b.hostId &&
    a.project?.projectId === b.project?.projectId &&
    a.session?.sessionId === b.session?.sessionId
  )
}
