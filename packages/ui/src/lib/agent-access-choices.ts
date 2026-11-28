import { agentAccessModes, type AgentAccessMode } from '@pi-meme/contracts/agent-access'

const descriptions = {
  'read-only': { label: '本地只读', description: '允许读取文件和联网，禁止修改本地文件。' },
  'workspace-write': { label: '工作区内修改', description: '允许修改当前项目和会话临时目录。' },
  'full-access': { label: '完全权限', description: '允许修改项目外文件，并加载已授权的 Agent 插件与 MCP。' },
} satisfies Record<AgentAccessMode, { label: string; description: string }>

export const agentAccessChoices = agentAccessModes.map((mode) => ({ mode, ...descriptions[mode] }))
