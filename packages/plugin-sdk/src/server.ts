import type { HostApi } from '@pi-meme/contracts/app-host'
import type { Disposer } from './scope'
import type { JsonSchema, JsonValue, PluginCallContext, PluginEffect, OperationDefinition } from './rpc'
import type { RestrictedCapability } from './permissions'

export type PluginHandler = (...args: unknown[]) => unknown | Promise<unknown>
export type PluginHandlers = Record<string, PluginHandler>
export type PluginServices = { require: <T>(name: string) => T }
export type PluginOperation = {
  name: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  audience: readonly ('ui' | 'agent')[]
  effect: PluginEffect
  capabilities: readonly RestrictedCapability[]
  execute: (input: JsonValue, context: PluginCallContext) => JsonValue | Promise<JsonValue>
}
export function defineServerOperation<Input, Output>(
  definition: OperationDefinition<Input, Output>,
  implementation: Omit<PluginOperation, 'name' | 'inputSchema' | 'outputSchema' | 'execute'> & {
    execute: (input: Input, context: PluginCallContext) => Output | Promise<Output>
  },
): PluginOperation {
  return {
    name: definition.name,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    ...implementation,
    execute: async (input, context) => (await implementation.execute(input as Input, context)) as JsonValue,
  }
}
export type SharedDataSnapshot = { value: JsonValue; revision: number }
export type SharedDataPublisher = {
  getSnapshot: (key: string, options?: { scope?: string }) => Promise<SharedDataSnapshot | undefined>
  publish: (
    key: string,
    value: JsonValue,
    options: { scope?: string; expectedRevision: number },
  ) => Promise<SharedDataSnapshot>
}
export type ServerPluginContext = {
  pluginId: string
  generation: number
  dataDirectory: string
  readonly host: HostApi
  services: PluginServices
  registerOperations: (operations: readonly PluginOperation[]) => Disposer
  sharedData: SharedDataPublisher
  provide: <T>(name: string, service: T) => Disposer
  onDispose: (disposer: Disposer) => void
}
export type ServerPluginInstance = { dispose?: Disposer }
export type ServerPluginModule = {
  create: (context: ServerPluginContext) => void | ServerPluginInstance | Promise<void | ServerPluginInstance>
}
