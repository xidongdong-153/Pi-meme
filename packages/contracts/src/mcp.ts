/** 保存服务时显式授权；由 Host 将列表与完整服务配置哈希一起绑定。工具名称使用远端原始名称。 */
export type McpServerPlanAuthorization = { planReadOnlyTools?: string[] }
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

export interface McpBridge {
  getMcpConfig: () => Promise<McpConfigSnapshot>
  saveMcpServer: (input: SaveMcpServer) => Promise<McpConfigSnapshot>
  deleteMcpServer: (input: DeleteMcpServer) => Promise<McpConfigSnapshot>
  checkMcpServers: (sessionKey: string) => Promise<McpDiagnostic>
}
