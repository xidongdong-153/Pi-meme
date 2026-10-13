export type AgentAccessMode = 'read-only' | 'workspace-write' | 'full-access'

export const defaultAccessMode: AgentAccessMode = 'workspace-write'

export const agentAccessChoices = [
  { mode: 'read-only', label: '仅可查看', description: '允许读取文件和联网，禁止修改本地文件。' },
  {
    mode: 'workspace-write',
    label: '工作区内修改',
    description: '允许修改当前项目和会话临时目录，读取和联网不受限。',
  },
  {
    mode: 'full-access',
    label: '完全权限',
    description: '允许修改项目外文件，并加载外部 Agent 插件。',
  },
] as const satisfies ReadonlyArray<{ mode: AgentAccessMode; label: string; description: string }>

export function isAgentAccessMode(value: unknown): value is AgentAccessMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'full-access'
}

export type AgentAccessEvent = { type: 'access_mode_changed'; mode: AgentAccessMode }
