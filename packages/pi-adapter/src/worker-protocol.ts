import { isAgentAccessMode, type AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type { Connection } from '@pi-meme/contracts/desktop'
import { isTaskMode, type TaskMode } from '@pi-meme/contracts/plan'
import type { ResourceSnapshot } from '@pi-meme/contracts/resources'
import type { ReadErrorCode, SystemReadErrorDetails } from '@pi-meme/contracts/system-read'
import type { DesktopSettings, ToolExecutionSettings } from '@pi-meme/contracts/settings'
import type { AgentPluginEntry } from '@pi-meme/plugin-sdk/agent'
import type { PromptTemplate } from '@earendil-works/pi-coding-agent'

export type SessionWorkerData = {
  cwd: string
  root: string
  temporaryRoot?: string
  settings: DesktopSettings
  agentEntries: AgentPluginEntry[]
  credentials: Array<[string, string]>
  access: AgentAccessMode
  taskMode: TaskMode
  capabilities: ToolExecutionSettings
  initialGeneration: number
  resourceSnapshot?: ResourceSnapshot
  promptTemplates?: PromptTemplate[]
}

export type WorkerCommand = { id: number; method: string; args: unknown[] }

export type HostWorkerMessage =
  | WorkerCommand
  | { credentialReply: number; error?: string }
  | { mcpCredential: { key: string; value?: string } }
  | {
      hostReply: string
      result?: unknown
      error?: string
      errorCode?: ReadErrorCode
      errorDetails?: SystemReadErrorDetails
    }

export function validateWorkerCommand(command: WorkerCommand) {
  if (
    !Number.isSafeInteger(command.id) ||
    command.id <= 0 ||
    typeof command.method !== 'string' ||
    !Array.isArray(command.args)
  )
    throw new Error('Worker 请求参数无效')
  const [value, revision] = command.args
  if (command.method === 'configureAccess' && !isAgentAccessMode(value)) throw new Error('Agent 访问权限无效')
  if (command.method === 'setSessionMode' && !isTaskMode(value)) throw new Error('会话模式无效')
  if (
    command.method === 'setPaused' &&
    (typeof value !== 'boolean' || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
  )
    throw new Error('会话暂停请求无效')
}

export type WorkerReply = {
  id?: number
  result?: unknown
  error?: string
  notify?: 'connection' | 'event' | 'error' | 'title'
  value?: unknown
  connection: Connection
  active: { sessionFile?: string; sessionId?: string }
}
