export type McpServerEntry = { name: string; config: unknown; error?: string }
export type McpConfigSnapshot = {
  path: string
  revision: string
  servers: McpServerEntry[]
  error?: string
}
export type SaveMcpServer = { revision: string; name: string; previousName?: string; config: unknown }
export type DeleteMcpServer = { revision: string; name: string }
export type McpDiagnostic = { checkedAt: string; output: string; exitCode: number | null; timedOut: boolean }

export type AcquireMcpRefreshLock = (credentialKey: string) => Promise<() => void | Promise<void>>
export type McpReference = { name: string; revision: string }
export type McpTarget = McpReference & { sessionKey?: string }
export type McpCheck = { checkedAt: string } & (
  { state: 'connected'; tools: number } | { state: 'needs-auth' | 'failed'; message: string }
)
export type McpService = McpReference & {
  source: 'global' | 'project'
  transport: 'http' | 'stdio'
  endpoint: string
  description?: string
  enabled: boolean
  authorized: boolean
  visible: boolean
  authentication: 'auto' | 'headers' | 'provider' | 'environment'
  provider?: string
  authenticationConfigured: boolean
  environmentConfigured: boolean
  headersConfigured: boolean
  signedIn: boolean
  loginId?: string
  check?: McpCheck
  error?: string
}
export type McpCatalog = { services: McpService[]; errors: string[] }
export type McpLogin = {
  id: string
  status: 'starting' | 'waiting' | 'checking' | 'done' | 'cancelled' | 'failed'
  url?: string
  error?: string
}

/** Stable, message-local references survive draft recovery, queueing and history edits. */
export function mcpMention(ref: McpReference) {
  return `@[MCP:${ref.name}#${ref.revision}]`
}
export function mcpReferences(text: string) {
  return Array.from(text.matchAll(/@\[MCP:([\w-]+)#([a-f0-9]{64})\]/g), (match) => ({
    name: match[1],
    revision: match[2],
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }))
}
export const mcpSettingsHint = '请前往设置 → Agent → MCP 管理服务。'

export interface McpBridge {
  getMcpCatalog: (sessionKey?: string) => Promise<McpCatalog>
  setMcpServiceEnabled: (target: McpTarget, enabled: boolean) => Promise<void>
  checkMcpService: (target: McpTarget) => Promise<McpCheck>
  startMcpLogin: (target: McpTarget) => Promise<McpLogin>
  getMcpLogin: (id: string) => Promise<McpLogin>
  respondMcpLogin: (id: string, redirectUrl: string) => Promise<McpLogin>
  cancelMcpLogin: (id: string) => Promise<McpLogin>
  logoutMcpService: (target: McpTarget) => Promise<void>
  getMcpConfig: () => Promise<McpConfigSnapshot>
  saveMcpServer: (input: SaveMcpServer) => Promise<McpConfigSnapshot>
  deleteMcpServer: (input: DeleteMcpServer) => Promise<McpConfigSnapshot>
  checkMcpServers: (sessionKey: string) => Promise<McpDiagnostic>
}
