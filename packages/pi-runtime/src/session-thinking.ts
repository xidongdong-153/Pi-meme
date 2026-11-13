import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent'
import type { SystemMessage } from '@earendil-works/pi-ai'
import { collaborationLimits } from '@pi-meme/contracts/collaboration'
import { thinkingLevels, type SessionThinkingLevel, type ThinkingLevel } from '@pi-meme/contracts/pi'

export const sessionThinkingEntry = 'pi-meme-session-thinking'
export const ultraPromptSection = 'app_ultra'

/** 策略独立于模型原生档位；只读取当前分支的最后一个检查点。 */
export function projectSessionThinkingLevel(
  branch: readonly SessionEntry[],
  nativeLevel: unknown,
  allowUltra = true,
): SessionThinkingLevel {
  const checkpoint = branch.findLast((entry) => entry.type === 'custom' && entry.customType === sessionThinkingEntry)
  const data = checkpoint?.type === 'custom' ? checkpoint.data : undefined
  if (
    allowUltra &&
    data &&
    typeof data === 'object' &&
    'version' in data &&
    data.version === 1 &&
    'ultra' in data &&
    data.ultra === true
  )
    return 'ultra'
  return typeof nativeLevel === 'string' && (thinkingLevels as readonly string[]).includes(nativeLevel)
    ? (nativeLevel as ThinkingLevel)
    : 'off'
}

export function appendSessionThinkingSelection(
  manager: Pick<SessionManager, 'getBranch' | 'appendCustomEntry'>,
  level: SessionThinkingLevel,
  force = false,
) {
  const branch = manager.getBranch()
  const previous = projectSessionThinkingLevel(branch, 'off') === 'ultra'
  const ultra = level === 'ultra'
  if (!force && previous === ultra) return
  manager.appendCustomEntry(sessionThinkingEntry, { version: 1, ultra })
}

/** Pi 将命名提示 section 保存为 system 消息；撤销策略时也要剥离历史补丁。 */
export function stripUltraSystemMessage<T extends { role: string }>(message: T): T {
  if (message.role !== 'system') return message
  const system = message as T & SystemMessage
  if (!system.sections || !(ultraPromptSection in system.sections)) return message
  const { [ultraPromptSection]: _ultra, ...sections } = system.sections
  return { ...message, sections }
}

export const ultraDelegationPrompt = [
  'Ultra is a root-session strategy for this run, not a model or a provider effort level.',
  'For substantial work, look early for genuinely independent subtasks and proactively delegate them in parallel when this improves the outcome. Keep simple, tightly coupled, or low-overhead tasks local; do not spawn agents merely to use Ultra.',
  'Use only collaboration tools actually declared or reachable through the available tool discovery mechanism. Before creating or reusing children, inspect list_agents and respect its current capacity and execution states.',
  `Across the task tree there are at most ${collaborationLimits.activeChildren} active or queued child identities and ${collaborationLimits.identities} child identities total. Waiting children still occupy capacity. Only the root may create children; the maximum child depth is ${collaborationLimits.depth}. Never ask children to recursively delegate or inherit this Ultra strategy.`,
  'Give children bounded responsibilities, necessary context, clear ownership and completion criteria, including calling finish_agent. Scope no-tools restrictions to business actions; do not accidentally prohibit collaboration reporting or completion. Avoid conflicting concurrent writes and unnecessary duplicate work. Use send_message for feedback within the same task, followup_task only for a new task on an existing child, and wait_agent to receive results. If wait_agent reports feedbackRequired, review the child reply and send actionable feedback instead of repeatedly waiting.',
  'Children remain within the current effective permissions, task mode, workspace and tool availability. Do not delegate to bypass read-only or Plan restrictions, user approval, blocked operations, or capacity limits.',
  'Honor the user’s explicit model and thinking-level choices. Ultra alone is not permission to override child models or native thinking levels: omit overrides or pass null unless the user explicitly requested them, and query list_agent_models before applying requested overrides. When the provider requires these fields, pass null to preserve defaults; never guess a model or native effort to fill required fields. Configured child defaults remain authoritative.',
  'Review delegated results, resolve outstanding work and feedback, and integrate the evidence yourself before presenting the final outcome. Parallelism does not replace correctness or independent acceptance when the project requires it.',
].join('\n')
