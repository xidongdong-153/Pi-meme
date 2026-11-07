export const mcpMetadataMethods = [
  'initialize',
  'ping',
  'tools/list',
  'notifications/initialized',
  'notifications/cancelled',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
  'transport.http.get',
  'transport.http.delete',
  'protocol.response',
] as const
export type McpMetadataMethod = (typeof mcpMetadataMethods)[number]

type McpAuthorizationStart = {
  phase: 'start'
  callId: string
  serverName: string
  input: unknown
  configHash: string
}
export type McpAuthorizationRequest =
  | (McpAuthorizationStart & {
      kind?: 'tool'
      toolName: string
      /** 候选注解；Host 另查白名单及配置哈希。 */
      annotatedReadOnly: boolean
    })
  | (McpAuthorizationStart & { kind: 'metadata'; method: McpMetadataMethod })
  | { phase: 'finish'; callId: string; failed: boolean }

export type McpAuthorizeOperation = (request: McpAuthorizationRequest, signal?: AbortSignal) => Promise<void>
