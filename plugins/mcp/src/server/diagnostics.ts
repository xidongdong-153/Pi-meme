import { McpClient, StdioTransport, StreamableHttpTransport } from '@earendil-works/pi-mcp'
import type { McpDiagnostic } from '@pi-meme/contracts/mcp'
import { object } from '../shared/config'

type ServerConfig = {
  name: string
  enabled: boolean
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  headers?: Record<string, string>
  timeout?: number
  needsAuth: boolean
}

function parseServers(contents: string): { servers: ServerConfig[]; error?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return { servers: [], error: 'MCP 配置文件不是有效 JSON' }
  }
  if (!object(parsed) || !object(parsed.mcpServers)) return { servers: [], error: 'MCP 配置缺少 mcpServers 对象' }
  const servers: ServerConfig[] = []
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    if (!object(value)) continue
    const config = value as Record<string, unknown>
    const strings = (input: unknown) =>
      object(input)
        ? Object.fromEntries(
            Object.entries(input)
              .filter(([, item]) => typeof item === 'string')
              .map(([key, item]) => [key, item as string]),
          )
        : undefined
    servers.push({
      name,
      enabled: config.enabled !== false,
      url: typeof config.url === 'string' ? config.url : undefined,
      command: typeof config.command === 'string' ? config.command : undefined,
      args: Array.isArray(config.args)
        ? config.args.filter((item): item is string => typeof item === 'string')
        : undefined,
      env: strings(config.env),
      cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
      headers: strings(config.headers),
      timeout: typeof config.timeout === 'number' && config.timeout > 0 ? config.timeout : undefined,
      needsAuth: object(config.auth) || object(config.oauth),
    })
  }
  return { servers }
}

async function checkServer(config: ServerConfig, timeoutMs: number) {
  if (config.needsAuth)
    return { lines: [`${config.name}: 该服务需要 OAuth 登录，请在 Desktop 会话中完成认证后再检查`], failed: true }
  const transport = config.url
    ? new StreamableHttpTransport({ url: config.url, headers: config.headers })
    : new StdioTransport({
        command: config.command!,
        args: config.args,
        cwd: config.cwd,
        env: config.env,
        inheritEnv: true,
        stderr: 'pipe',
      })
  const client = new McpClient({
    name: 'pi-meme',
    version: '0.0.0',
    requestTimeoutMs: Math.min((config.timeout ?? 30) * 1000, timeoutMs),
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min((config.timeout ?? 30) * 1000, timeoutMs))
  try {
    await client.connect(transport)
    const tools = await client.listTools({ signal: controller.signal })
    const info = client.serverInfo
    return {
      lines: [`${config.name}: 已连接${info ? `（${info.name} ${info.version}）` : ''}，共 ${tools.length} 个工具`],
      failed: false,
    }
  } catch (cause) {
    const stderr = transport instanceof StdioTransport ? transport.stderr.trim() : ''
    return { lines: [`${config.name}: 连接失败：${String(cause)}${stderr ? `\n${stderr}` : ''}`], failed: true }
  } finally {
    clearTimeout(timer)
    await client.close().catch(() => {})
  }
}

/**
 * 进程内检查 Desktop 全局 mcp.json 里的服务：逐个连接并列出工具，产出诊断文本。
 *
 * 检查不经过会话，也不会启动 Pi 进程；需要 OAuth 登录的服务提示在 Desktop 会话中完成认证。
 */
export async function checkMcpServers(filePath: string, timeoutMs = 90_000): Promise<McpDiagnostic> {
  const checkedAt = new Date().toISOString()
  let contents: string
  try {
    contents = await (await import('node:fs/promises')).readFile(filePath, 'utf8')
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException).code === 'ENOENT'
    return {
      checkedAt,
      output: missing ? `未找到 MCP 配置文件：${filePath}` : `无法读取 MCP 配置：${String(cause)}`,
      exitCode: 1,
      timedOut: false,
    }
  }
  const { servers, error } = parseServers(contents)
  if (error) return { checkedAt, output: error, exitCode: 1, timedOut: false }
  const enabled = servers.filter((server) => server.enabled && (server.url || server.command))
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
    const result = await checkServer(server, remaining)
    if (result.failed) failed = true
    lines.push(...result.lines)
  }
  return { checkedAt, output: lines.join('\n'), exitCode: failed ? 1 : 0, timedOut: false }
}
