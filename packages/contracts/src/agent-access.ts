import type { TaskMode } from './plan'

export type AgentAccessMode = 'read-only' | 'workspace-write' | 'full-access'

export const defaultAccessMode: AgentAccessMode = 'workspace-write'

export const agentAccessChoices = [
  { mode: 'read-only', label: '本地只读', description: '允许读取文件和联网，禁止修改本地文件。' },
  {
    mode: 'workspace-write',
    label: '工作区内修改',
    description: '允许修改当前项目和会话临时目录。',
  },
  {
    mode: 'full-access',
    label: '完全权限',
    description: '允许修改项目外文件，并加载已授权的 Agent 插件与 MCP。',
  },
] as const satisfies ReadonlyArray<{ mode: AgentAccessMode; label: string; description: string }>

export function isAgentAccessMode(value: unknown): value is AgentAccessMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'full-access'
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
  get_goal: 'read-only',
  update_goal: 'read-only',
}

export function isBuiltinAgentToolAllowed(name: string, effectiveAccess: AgentAccessMode): boolean {
  const required = Object.hasOwn(builtinAgentToolRequirements, name) ? builtinAgentToolRequirements[name] : undefined
  return required !== undefined && agentAccessRank(effectiveAccess) >= agentAccessRank(required)
}

export type AgentAccessEvent = { type: 'access_mode_changed'; mode: AgentAccessMode }
