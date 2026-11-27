import { McpClient } from '@earendil-works/pi-mcp'
import type { LoadedMcpConfig, McpServerEntry } from '@earendil-works/pi-coding-agent'
import type { McpDiagnostic } from '@pi-meme/contracts/mcp'
import { createMcpTransport } from './connection'

async function checkServer({ name, config }: McpServerEntry, cwd: string, timeoutMs: number) {
  if ('url' in config && (config.auth || config.oauth))
    return { line: `${name}: 请在设置 → Agent → MCP 中检查此服务，使用它配置的认证方式`, failed: true }
  const client = new McpClient({
    name: 'pi-meme',
    version: '0.0.0',
    requestTimeoutMs: Math.min((config.timeout ?? 30) * 1000, timeoutMs),
  })
  const controller = new AbortController()
  const timer = setTimeout(
    () => {
      controller.abort()
      void client.close().catch(() => {})
    },
    Math.min((config.timeout ?? 30) * 1000, timeoutMs),
  )
  try {
    await client.connect(createMcpTransport(config, cwd, undefined, false))
    const tools = client.serverCapabilities?.tools ? await client.listTools({ signal: controller.signal }) : []
    return { line: `${name}: 已连接，共 ${tools.length} 个工具`, failed: false }
  } catch {
    return { line: `${name}: 连接失败，请检查服务地址、启动配置与网络`, failed: true }
  } finally {
    clearTimeout(timer)
    await client.close().catch(() => {})
  }
}

export async function checkMcpServers(
  config: LoadedMcpConfig,
  cwd: string,
  timeoutMs = 90_000,
): Promise<McpDiagnostic> {
  const checkedAt = new Date().toISOString()
  if (config.errors.length)
    return { checkedAt, output: 'MCP 配置不可用，请查看设置中的服务状态', exitCode: 1, timedOut: false }
  const enabled = config.servers.filter(({ config }) => config.enabled !== false)
  if (!enabled.length) return { checkedAt, output: '没有已启用的 MCP 服务', exitCode: 0, timedOut: false }
  const deadline = Date.now() + timeoutMs
  const lines: string[] = []
  let failed = false
  for (const server of enabled) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      lines.push(`${server.name}: 检查超时`)
      return { checkedAt, output: lines.join('\n'), exitCode: 1, timedOut: true }
    }
    const result = await checkServer(server, cwd, remaining)
    lines.push(result.line)
    failed ||= result.failed
  }
  return { checkedAt, output: lines.join('\n'), exitCode: failed ? 1 : 0, timedOut: false }
}
