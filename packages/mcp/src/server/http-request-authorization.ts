import { randomUUID } from 'node:crypto'
import {
  mcpMetadataMethods,
  type McpAuthorizeOperation,
  type McpMetadataMethod,
} from '@pi-meme/contracts/mcp-authorization'
import { parseJsonRpcMessage, type JsonRpcMessage } from '@earendil-works/pi-mcp'
import type { McpServerEntry } from '@earendil-works/pi-coding-agent'
import { mcpAuthorization } from '../shared/authorization'

export type McpHttpSource = { message?: JsonRpcMessage; toolPosts: number; closing?: boolean }

/** Source is private transport state, never a value supplied in tool arguments. */
export async function authorizeMcpHttpRequest(
  entry: McpServerEntry,
  authorize: McpAuthorizeOperation | undefined,
  url: URL,
  init: RequestInit | undefined,
  source: McpHttpSource | undefined,
  signal: AbortSignal,
): Promise<((failed: boolean) => Promise<void>) | undefined> {
  const verb = (init?.method ?? 'GET').toUpperCase()
  let method: McpMetadataMethod
  let message: JsonRpcMessage | undefined
  if (verb === 'POST') {
    if (typeof init?.body !== 'string' || Buffer.byteLength(init.body) > 1048576)
      throw new Error('permission-denied: MCP HTTP 必须是有界 JSONRPC 消息')
    message = parseJsonRpcMessage(JSON.parse(init.body))
    if (!source?.message || JSON.stringify(source.message) !== JSON.stringify(message))
      throw new Error('permission-denied: MCP HTTP 消息没有匹配的真实 transport send')
    if ('method' in message && message.method === 'tools/call') {
      if (source.toolPosts++) throw new Error('mcp-replay-denied: 不自动重放已发送的工具调用')
      return undefined // The real tool lease is held by guardMcpTransport through its RPC response.
    }
    const candidate = 'method' in message ? message.method : 'protocol.response'
    if (!(mcpMetadataMethods as readonly string[]).includes(candidate) || candidate.startsWith('transport.'))
      throw new Error('permission-denied: MCP 未知方法不能冒充 metadata')
    method = candidate as McpMetadataMethod
  } else if (verb === 'GET') method = 'transport.http.get'
  else if (verb === 'DELETE' && source?.closing) method = 'transport.http.delete'
  else throw new Error('permission-denied: MCP HTTP 方法不是固定协议适配器')
  if (!authorize) throw new Error('permission-denied: MCP metadata 缺少 Host 私有授权桥')
  const callId = randomUUID()
  await authorize(
    {
      phase: 'start',
      kind: 'metadata',
      callId,
      serverName: entry.name,
      configHash: mcpAuthorization(entry.config),
      method,
      input: {
        url: url.href,
        httpMethod: verb,
        ...(message ? { message } : {}),
        ...(source?.closing ? { transportSessionCleanup: true } : {}),
      },
    },
    signal,
  )
  let finished = false
  return async (failed) => {
    if (finished) return
    finished = true
    await authorize({ phase: 'finish', callId, failed })
  }
}
