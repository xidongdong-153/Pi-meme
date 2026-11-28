import type { TaskMode } from './plan'

export const agentAccessModes = ['read-only', 'workspace-write', 'full-access'] as const
export type AgentAccessMode = (typeof agentAccessModes)[number]

export const defaultAccessMode: AgentAccessMode = 'workspace-write'

export function isAgentAccessMode(value: unknown): value is AgentAccessMode {
  return typeof value === 'string' && (agentAccessModes as readonly string[]).includes(value)
}

const accessRanks: Record<AgentAccessMode, number> = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 }

export function agentAccessRank(mode: AgentAccessMode): number {
  return accessRanks[mode]
}

/** 有效权限只在执行时计算，不覆盖用户保存的权限选择。 */
export function effectiveAgentAccess(
  accessMode: AgentAccessMode,
  taskMode: TaskMode = 'default',
  parentAccess?: AgentAccessMode,
): AgentAccessMode {
  if (taskMode === 'plan') return 'read-only'
  return parentAccess && agentAccessRank(parentAccess) < agentAccessRank(accessMode) ? parentAccess : accessMode
}

export function canUseExternalAgentTools(
  accessMode: AgentAccessMode,
  taskMode: TaskMode = 'default',
  parentAccess?: AgentAccessMode,
): boolean {
  return effectiveAgentAccess(accessMode, taskMode, parentAccess) === 'full-access'
}

/** manage_service 的 list/logs 可读；start/stop 还须在执行入口检查工作区写入权限。 */
export const builtinAgentToolRequirements: Readonly<Record<string, AgentAccessMode>> = {
  read: 'read-only',
  bash: 'read-only',
  powershell: 'read-only',
  grep: 'read-only',
  find: 'read-only',
  ls: 'read-only',
  codemode: 'read-only',
  system_read: 'read-only',
  system_write: 'full-access',
  write: 'workspace-write',
  edit: 'workspace-write',
  image_gen: 'workspace-write',
  manage_service: 'read-only',
  spawn_agent: 'read-only',
  send_message: 'read-only',
  followup_task: 'read-only',
  interrupt_agent: 'read-only',
  list_agents: 'read-only',
  list_agent_models: 'read-only',
  wait_agent: 'read-only',
  finish_agent: 'read-only',
  request_user_input: 'read-only',
  save_visualization: 'read-only',
  read_visualization: 'read-only',
  save_plan: 'read-only',
  update_plan: 'read-only',
  get_goal: 'read-only',
  update_goal: 'read-only',
}

export function isBuiltinAgentToolAllowed(name: string, effectiveAccess: AgentAccessMode): boolean {
  const required = Object.hasOwn(builtinAgentToolRequirements, name) ? builtinAgentToolRequirements[name] : undefined
  return required !== undefined && agentAccessRank(effectiveAccess) >= agentAccessRank(required)
}

export type AgentAccessEvent = { type: 'access_mode_changed'; mode: AgentAccessMode; revision?: number }

export function isAccessRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
