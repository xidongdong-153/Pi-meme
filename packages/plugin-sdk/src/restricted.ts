import type { AgentPluginContext, AgentTool } from './agent'
import type { PluginEffect, PluginServerClient } from './rpc'
import type { RestrictedCapability } from './permissions'
import type { PluginOperation, SharedDataSnapshot } from './server'
import type { Disposer } from './scope'

export type PluginHttpRequest = {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
  credentialRef?: string
}
export type PluginHttpResponse = { status: number; headers: Record<string, string>; body: string }
export type RestrictedServices = {
  server: PluginServerClient
  http: { request: (input: PluginHttpRequest, options?: { signal?: AbortSignal }) => Promise<PluginHttpResponse> }
  sharedData: { read: (key: string) => Promise<SharedDataSnapshot> }
  interaction: {
    request: AgentPluginContext['interaction']['request']
    notify: (...args: Parameters<AgentPluginContext['interaction']['notify']>) => Promise<void>
    setStatus: (...args: Parameters<AgentPluginContext['interaction']['setStatus']>) => Promise<void>
  }
}
export type RestrictedAgentContext = Omit<AgentPluginContext, 'tools' | 'commands' | 'messages' | 'interaction'> &
  RestrictedServices & {
    tools: {
      register: (tool: AgentTool & { effect: PluginEffect; capabilities: readonly RestrictedCapability[] }) => void
    }
    commands: {
      register: (
        command: Parameters<AgentPluginContext['commands']['register']>[0] & {
          effect: PluginEffect
          capabilities: readonly RestrictedCapability[]
        },
      ) => void
    }
    messages: { emit: (...args: Parameters<AgentPluginContext['messages']['emit']>) => Promise<void> }
  }
export type RestrictedServerContext = RestrictedServices & {
  pluginId: string
  generation: number
  registerOperations: (operations: readonly PluginOperation[]) => Disposer
  onDispose: (disposer: Disposer) => void
}
