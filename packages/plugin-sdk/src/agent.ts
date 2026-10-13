import type { UserInputQuestion, UserInputResult } from '@pi-meme/contracts/user-input'
import type { Disposer } from './scope'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonSchema = {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}
export type AgentSession = { id: string; cwd: string }
export type AgentRun = { id: string }
export type AgentExecutionContext = { session: AgentSession; run: AgentRun; signal: AbortSignal }
export type AgentToolResult = { text: string; data?: JsonValue }
export type AgentTool = {
  name: string
  title: string
  description: string
  parameters: JsonSchema
  execute: (
    parameters: Record<string, unknown>,
    context: AgentExecutionContext,
  ) => Promise<AgentToolResult> | AgentToolResult
}
export type AgentHookEvents = {
  sessionStart: { session: AgentSession }
  sessionEnd: { session: AgentSession }
  beforeRun: AgentExecutionContext & { prompt: string }
  runStart: AgentExecutionContext
  runEnd: AgentExecutionContext
}
export type AgentHookResult<K extends keyof AgentHookEvents> = K extends 'beforeRun'
  ? { context: string } | undefined
  : void
export type AgentPluginContext = {
  pluginId: string
  generation: number
  tools: { register: (tool: AgentTool) => void }
  hooks: {
    on: <K extends keyof AgentHookEvents>(
      event: K,
      handler: (event: AgentHookEvents[K]) => AgentHookResult<K> | Promise<AgentHookResult<K>>,
    ) => Disposer
  }
  commands: {
    register: (command: {
      name: string
      description: string
      execute: (args: string, context: AgentExecutionContext) => void | Promise<void>
    }) => void
  }
  messages: { emit: (message: { type: string; text: string; data?: JsonValue }) => void }
  interaction: {
    request: (questions: UserInputQuestion[], signal?: AbortSignal) => Promise<UserInputResult>
    notify: (message: string, level?: 'info' | 'warning' | 'error') => void
    setStatus: (key: string, text?: string) => void
  }
  onDispose: (disposer: Disposer) => void
}
export type AgentPluginModule = {
  activate: (context: AgentPluginContext) => void | Disposer | Promise<void | Disposer>
}
export type AgentPluginEntry = { pluginId: string; generation: number; path: string }

export type InteractionPluginContext = {
  registerInteractionPolicy: (enabled: boolean) => void
  requestUserInput: (questions: UserInputQuestion[], signal?: AbortSignal) => Promise<UserInputResult>
}
