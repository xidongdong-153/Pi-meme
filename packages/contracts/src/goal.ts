import type { SessionRef, SubmissionReceipt } from './app-host'
import type { PiImage } from './pi'
import type { MessageConfiguration } from './plan'
import { skillMarker, type SkillReference } from './skills'

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'usage_limited' | 'complete'
export type GoalControl = { goalId: string; revision: number }
export type GoalResumeControl = GoalControl & { configuration?: MessageConfiguration }
export type Goal = GoalControl & {
  session: SessionRef
  objective: string
  status: GoalStatus
  tokensUsed: number
  elapsedMs: number
  usageIncomplete: boolean
  progress?: string
  evidence: string[]
  blocker?: { key: string; count: number }
  reason?: string
  turns: number
  createdAt: string
  updatedAt: string
  inputEntryId?: string
}
export type GoalInput = {
  objective: string
  images?: PiImage[]
  skills?: SkillReference[]
  /** 将当前分支的已有用户消息设为目标，不重复发送原消息。 */
  sourceMessageTimestamp?: number
}
export type GoalEdit = GoalControl & { objective: string }
export type GoalStartResult = { goal: Goal; receipt: SubmissionReceipt }
export type GoalUpdate = {
  status: 'active' | 'complete' | 'blocked' | 'paused'
  summary: string
  progress?: 'progress' | 'waiting' | 'blocked'
  blockerKey?: string
  evidence?: string[]
}
export type GoalEvent = { type: 'goal_updated'; goal: Goal } | { type: 'goal_cleared'; goalId: string }
export type GoalRun = { goalId: string; cycleId: string; session: SessionRef }
export type PromptOrigin = 'user' | 'collaboration' | 'goal' | 'recovery'
export type GoalRequest =
  { method: 'get' } | { method: 'gate'; tool?: boolean } | { method: 'update'; input: GoalUpdate }
export const goalRunEntry = 'pi-meme-goal-run'
export const goalCommands = ['goal', '目标', '目标模式'] as const

/** 只解析输入开头的命令，正文中的斜杠不改变目标。 */
export function parseGoalCommand(text: string) {
  const match = text.match(/^\s*\/(?:goal|目标模式|目标)(?=$|\s)/u)
  if (!match) return undefined
  const body = text.slice(match[0].length).trim()
  const action = ['pause', 'resume', 'edit', 'clear'].includes(body)
    ? (body as 'pause' | 'resume' | 'edit' | 'clear')
    : body
      ? 'start'
      : 'open'
  return { action, objective: action === 'start' ? body : '' } as const
}

export function validateGoalInput(input: Pick<GoalInput, 'objective'>) {
  if (!input || typeof input.objective !== 'string' || !input.objective.replaceAll(skillMarker, '').trim())
    throw new Error('请输入目标正文')
}

export function validateGoalControl(input: GoalControl) {
  if (
    !input ||
    typeof input.goalId !== 'string' ||
    !input.goalId ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1
  )
    throw new Error('目标控制需要 goalId 和有效修订号')
}

export function goalTokens(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Record<string, unknown>
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (valid(usage.totalTokens)) return usage.totalTokens
  const parts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
  if (!parts.some(valid) || parts.some((n) => n !== undefined && !valid(n))) return undefined
  return parts.reduce<number>((sum, n) => sum + (valid(n) ? n : 0), 0)
}

type UsageEntry = {
  type?: string
  message?: { role?: string; usage?: unknown; content?: unknown }
  usage?: unknown
}

export function isGoalUsageEntry(entry: UsageEntry) {
  return (
    (entry.type === 'message' && entry.message?.role === 'assistant') ||
    ['usage', 'compaction', 'branch_summary'].includes(entry.type ?? '') ||
    entry.usage !== undefined
  )
}

/** Pi 在服务商缺少 usage 时可能保留全零默认值；有输出时不能把它当成已知零消耗。 */
export function goalEntryUsage(entry: UsageEntry): unknown {
  const assistant = entry.type === 'message' && entry.message?.role === 'assistant'
  const usage = assistant ? entry.message?.usage : entry.usage
  if (goalTokens(usage) === 0) {
    const content = entry.message?.content
    if ((Array.isArray(content) && content.length > 0) || ['compaction', 'branch_summary'].includes(entry.type ?? ''))
      return undefined
  }
  return usage
}
