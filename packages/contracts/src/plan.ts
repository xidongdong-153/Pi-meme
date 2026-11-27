import {
  piNestedInteractionEntryType,
  readPiNestedInteractionEntry,
  type PiImage,
  type PiSessionEntry,
  type PiModel,
  type ServiceTier,
  type SessionThinkingLevel,
} from './pi'
import type { SkillReference } from './skills'

export type TaskMode = 'default' | 'plan'
export type ClientProcessingAudit = {
  attemptId: string
  pluginId: string
  generation: number
  hookId: string
  outcome: 'pass' | 'replace' | 'block' | 'error' | 'timeout' | 'skipped'
  reason?: string
  userConfirmedAt?: string
}
export type PromptReceipt = { entryId: string | null }
export type MessageOptions = MessageConfiguration & {
  /** 发起窗口用于核对本次普通发送的 RPC 请求 ID。 */
  promptRequestId?: string
  /** 仅由 Host 从已认证的提交上下文写入。 */
  sourceClientId?: string
  visualization?: import('./visualize').VisualizationMessageContext
  mode?: TaskMode
  plan?: PlanAction
  clientProcessingAudit?: readonly ClientProcessingAudit[]
}
export type MessageConfiguration = { model?: PiModel; thinkingLevel?: SessionThinkingLevel; serviceTier?: ServiceTier }

export function sameMessageConfiguration(left: MessageConfiguration, right: MessageConfiguration) {
  return (
    left.model?.provider === right.model?.provider &&
    left.model?.id === right.model?.id &&
    left.thinkingLevel === right.thinkingLevel &&
    (left.serviceTier ?? 'inherit') === (right.serviceTier ?? 'inherit')
  )
}
export type EditMessageOptions = MessageOptions & MessageConfiguration
/** 覆盖失败时仍返回已取出的队列，供发起编辑的窗口恢复。 */
export type EditMessageResult = { recoveredInputs: QueuedInput[]; error?: string }
export type QueuedInput = {
  sourceClientId?: string
  visualization?: import('./visualize').VisualizationMessageContext
  id: string
  editing?: boolean
  submitted?: boolean
  deliveryUncertain?: boolean
  text: string
  mode: TaskMode
  configuration?: MessageConfiguration
  clientProcessingAudit?: readonly ClientProcessingAudit[]
  images?: PiImage[]
  skills?: SkillReference[]
}
export type PlanDocument = {
  id: string
  sessionId: string
  runId: string
  revision: number
  title: string
  markdown: string
  updatedAt: string
}
export type PlanRef = { id: string; revision: number }
export type PlanCheckpoint = {
  document: PlanDocument
  /** 保存结果在原生分支中的条目。 */
  sourceEntryId: string
  /** 发起保存的最外层工具调用，用于在对话中定位卡片。 */
  rootToolCallId?: string
}
export type PlanState = Partial<PlanCheckpoint> & { sessionId: string; revision: number }
export type PlanAction = { intent: 'execute' | 'revise'; reference: PlanRef }
export type PlanEvent =
  | { type: 'plan_saved'; document: PlanDocument }
  | { type: 'plan_state_changed'; state: PlanState; reason: 'saved' | 'restored' }
export type SavePlanInput = { title: string; markdown: string; reference?: PlanRef }

export function planContextMessage(document: PlanDocument) {
  return `当前计划「${document.title}」\n\n${document.markdown}`
}

export function isPlanDocument(value: unknown): value is PlanDocument {
  if (!value || typeof value !== 'object') return false
  const document = value as Partial<PlanDocument>
  return (
    typeof document.id === 'string' &&
    /^[\w-]+$/.test(document.id) &&
    typeof document.sessionId === 'string' &&
    /^[\w-]+$/.test(document.sessionId) &&
    typeof document.runId === 'string' &&
    Number.isSafeInteger(document.revision) &&
    document.revision! > 0 &&
    typeof document.title === 'string' &&
    Boolean(document.title.trim()) &&
    typeof document.markdown === 'string' &&
    Boolean(document.markdown.trim()) &&
    typeof document.updatedAt === 'string'
  )
}

export function readPlanCheckpoint(entry: PiSessionEntry): PlanCheckpoint | undefined {
  if (entry.type === 'message') {
    const message = entry.message
    if (
      message.role === 'toolResult' &&
      message.toolName === 'save_plan' &&
      !message.isError &&
      isPlanDocument(message.details)
    )
      return { document: message.details, sourceEntryId: entry.id, rootToolCallId: message.toolCallId }
  }
  if (entry.type === 'custom' && entry.customType === piNestedInteractionEntryType) {
    const nested = readPiNestedInteractionEntry(entry.data)
    if (
      nested?.interaction.name === 'save_plan' &&
      nested.interaction.status === 'success' &&
      isPlanDocument(nested.interaction.result.details)
    )
      return {
        document: nested.interaction.result.details,
        sourceEntryId: entry.id,
        rootToolCallId: nested.rootToolCallId,
      }
  }
}

/** 从原始条目恢复方案；模型上下文压缩不影响这些保存检查点。 */
export function projectBranchPlans(entries: readonly PiSessionEntry[], leafId: string | null): PlanCheckpoint[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const seen = new Set<string>()
  const checkpoints: PlanCheckpoint[] = []
  let entry = leafId ? byId.get(leafId) : undefined
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id)
    const checkpoint = readPlanCheckpoint(entry)
    if (checkpoint) checkpoints.push(checkpoint)
    entry = entry.parentId ? byId.get(entry.parentId) : undefined
  }
  return checkpoints.reverse()
}

export function isTaskMode(value: unknown): value is TaskMode {
  return value === 'default' || value === 'plan'
}

/** Host 和界面使用同一命令规则；纯命令只切换模式。 */
export function normalizePlanMessage(
  text: string,
  mode: TaskMode,
): { text: string; mode: TaskMode; commandOnly: boolean } {
  const match = text.match(/^\s*\/(?:plan|计划模式|计划)(?=$|\s)/)
  if (!match) return { text, mode, commandOnly: false }
  const body = text.slice(match[0].length).trimStart()
  return { text: body, mode: 'plan', commandOnly: !body.trim() }
}
