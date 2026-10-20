export type RestrictedRegistration = {
  tools: Array<{
    name: string
    title: string
    description: string
    parameters: Record<string, unknown>
    effect: string
    capabilities: string[]
  }>
  commands: Array<{ name: string; description: string; effect: string; capabilities: string[] }>
  hooks: string[]
  operations: Array<{
    name: string
    inputSchema: Record<string, unknown>
    outputSchema: Record<string, unknown>
    audience: string[]
    effect: string
    capabilities: string[]
  }>
}
export type PluginRuntimeRequest = {
  pluginId: string
  generation: number
  action: 'initialize' | 'tool' | 'hook' | 'command' | 'server' | 'close'
  name?: string
  input?: unknown
}
export type PluginUiRequest = {
  pluginId: string
  generation: number
  method: string
  input: unknown
  scopeId?: string
  signal?: AbortSignal
}
export function pluginFailure(cause: unknown): { code: string; message: string } {
  const message = cause instanceof Error ? cause.message : String(cause)
  const match = message.match(/^(?:Error: )?([a-z]+(?:-[a-z]+)+): /)
  if (match) return { code: match[1], message: message.replace(/^Error: /, '') }
  if (cause instanceof Error && cause.name === 'AbortError') return { code: 'cancelled', message: '插件调用已取消' }
  if (cause instanceof Error && cause.name === 'TimeoutError') return { code: 'timeout', message: '插件调用超时' }
  return { code: 'operation-failed', message }
}
export type PluginExecutionPolicy = {
  policyRevision: string
  capabilities: string[]
  effectivePlugins: Array<{ id: string; generation: number }>
  unavailablePlugins: Array<{ id: string; reason: string }>
}
