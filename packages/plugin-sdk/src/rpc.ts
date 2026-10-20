import type { ProjectRef, SessionRef } from '@pi-meme/contracts/app-host'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type { TaskMode } from '@pi-meme/contracts/plan'
import type { RestrictedCapability } from './permissions'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonSchema = { type?: string; [key: string]: unknown }
export type PluginEffect = 'read' | 'workspace-write' | 'external-write' | 'full-access'
export type PluginTarget = { hostId: string; project?: ProjectRef; session?: SessionRef }
export type OperationDefinition<Input = JsonValue, Output = JsonValue> = {
  name: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  readonly __input?: Input
  readonly __output?: Output
}
export function defineOperation<Input, Output>(
  definition: Omit<OperationDefinition<Input, Output>, '__input' | '__output'>,
) {
  return definition as OperationDefinition<Input, Output>
}
export type PluginCallOptions = { signal?: AbortSignal; target?: PluginTarget }
export type PluginCallRequest = {
  pluginId: string
  generation: number
  policyHash: string
  operation: string
  input: JsonValue
  target?: PluginTarget
  leaseId?: string
  requestId: string
}
export type PluginCallContext = {
  pluginId: string
  generation: number
  policyHash?: string
  origin: 'ui' | 'agent'
  target: PluginTarget
  agentId?: string
  runId?: string
  epoch?: number
  executionGeneration?: number
  mode: TaskMode
  runtime?: 'trusted' | 'restricted'
  workspaceWritable?: boolean
  accessMode: AgentAccessMode
  capabilities: RestrictedCapability[]
  network?: import('./permissions').PluginNetworkPermission[]
  signal: AbortSignal
  requestId: string
}
export type PluginServerClient = {
  call: {
    <Output = JsonValue>(operation: string, input: JsonValue, options?: PluginCallOptions): Promise<Output>
    <Input, Output>(
      operation: OperationDefinition<Input, Output>,
      input: Input,
      options?: PluginCallOptions,
    ): Promise<Output>
  }
}
export type PluginUiLease = { id: string; pluginId: string; generation: number; expiresAt: number }
export function createPluginServerClient(options: {
  pluginId: string
  generation: number
  policyHash: string | undefined
  leaseId?: () => string | undefined
  invoke: (request: PluginCallRequest, signal?: AbortSignal) => Promise<unknown>
}): PluginServerClient {
  return {
    call: async (
      operation: string | OperationDefinition<unknown, unknown>,
      input: unknown,
      callOptions?: PluginCallOptions,
    ) => {
      if (!options.policyHash) throw new Error('policy-changed: 插件调用缺少代码快照 hash')
      const name = typeof operation === 'string' ? operation : operation.name
      if (!name || name.includes(':')) throw new Error('插件操作名称必须是本插件的本地名称')
      return options.invoke(
        {
          pluginId: options.pluginId,
          generation: options.generation,
          policyHash: options.policyHash,
          operation: name,
          input: input as JsonValue,
          target: callOptions?.target,
          leaseId: options.leaseId?.(),
          requestId: crypto.randomUUID(),
        },
        callOptions?.signal,
      ) as never
    },
  }
}
