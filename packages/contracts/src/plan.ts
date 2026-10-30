import type { PiImage, PiModel, ThinkingLevel } from './pi'
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
export type MessageOptions = MessageConfiguration & {
  /** 仅由 Host 从已认证的提交上下文写入。 */
  sourceClientId?: string
  visualization?: import('./visualize').VisualizationMessageContext
  mode?: TaskMode
  plan?: PlanAction
  clientProcessingAudit?: readonly ClientProcessingAudit[]
}
export type MessageConfiguration = { model?: PiModel; thinkingLevel?: ThinkingLevel }
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
export type PlanCheckpoint = { document: PlanDocument; sourceEntryId: string }
export type PlanState = {
  sessionId: string
  revision: number
  document?: PlanDocument
  sourceEntryId?: string
}
export type PlanAction = { intent: 'execute' | 'revise'; reference: PlanRef }
export type PlanToolSource = { readOnly?: boolean }
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

/** 从原始条目恢复方案；模型上下文压缩不影响这些保存检查点。 */
export function projectBranchPlans(
  entries: readonly { id: string; parentId: string | null; type: string; message?: unknown }[],
  leafId: string | null,
): PlanCheckpoint[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const seen = new Set<string>()
  const checkpoints: PlanCheckpoint[] = []
  let entry = leafId ? byId.get(leafId) : undefined
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id)
    const message = entry.message as
      { role?: string; toolName?: string; isError?: boolean; details?: unknown } | undefined
    if (
      entry.type === 'message' &&
      message?.role === 'toolResult' &&
      message.toolName === 'save_plan' &&
      !message.isError &&
      isPlanDocument(message.details)
    )
      checkpoints.push({ document: message.details, sourceEntryId: entry.id })
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
