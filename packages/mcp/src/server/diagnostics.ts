import { McpClient } from '@earendil-works/pi-mcp'
import type { McpServerEntry, McpServerConfig } from '@earendil-works/pi-coding-agent'
import type { McpDiagnostic } from '@pi-meme/contracts/mcp'
import type { AccessSandboxOperations } from '@pi-meme/pi-runtime/sdk/access-sandbox'
import { object, serverError } from '../shared/config'
import { mcpAuthorization } from '../shared/authorization'
import { createAuthorizedMcpTransport } from './plan-transport'
import { readDesktopMcpConfigFile } from './runtime-config'

/** 诊断也经过同一服务授权和隔离入口；缺少隔离器时不裸跑 stdio。 */
export async function checkMcpServers(
  filePath: string,
  timeoutMs = 90_000,
  sandbox?: () => AccessSandboxOperations,
  cwd = process.cwd(),
): Promise<McpDiagnostic> {
  const checkedAt = new Date().toISOString()
  const snapshot = readDesktopMcpConfigFile(filePath)
  if (snapshot.error || !snapshot.data)
    return { checkedAt, output: snapshot.error ?? `未找到 MCP 配置文件：${filePath}`, exitCode: 1, timedOut: false }
  const configured = snapshot.data.mcpServers
  if (!object(configured)) return { checkedAt, output: 'MCP 配置缺少 mcpServers 对象', exitCode: 1, timedOut: false }
  const enabled = Object.entries(configured).filter(([, config]) => object(config) && config.enabled !== false)
  if (!enabled.length) return { checkedAt, output: '没有已启用的 MCP 服务', exitCode: 0, timedOut: false }
  const transport = createAuthorizedMcpTransport(
    () => {
      if (!sandbox) throw new Error('sandbox-unavailable: stdio 诊断需要具备 Host 私有数据隔离和网络禁止能力的执行器')
      return sandbox()
    },
    (entry) => {
      const current = readDesktopMcpConfigFile(filePath)
      const servers = object(current.data?.mcpServers) ? current.data.mcpServers : {}
      const authorizations = object(current.data?.desktopAuthorizedServers) ? current.data.desktopAuthorizedServers : {}
      const config = servers[entry.name]
      const hash = mcpAuthorization(entry.config)
      return object(config) &&
        config.enabled !== false &&
        mcpAuthorization(config) === hash &&
        authorizations[entry.name] === hash
        ? []
        : undefined
    },
  )
  const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 300000))
  const lines: string[] = []
  let failed = false
  for (const [name, raw] of enabled) {
    if (Date.now() >= deadline)
      return { checkedAt, output: [...lines, `${name}: 检查超时`].join('\n'), exitCode: 1, timedOut: true }
    const issue = serverError(name, raw)
    if (issue || !object(raw)) {
      lines.push(`${name}: ${issue ?? '服务配置无效'}`)
      failed = true
      continue
    }
    if (object(raw.auth) || object(raw.oauth)) {
      lines.push(`${name}: 该服务需要登录，请在已授权的会话中完成认证后使用`)
      failed = true
      continue
    }
    const entry: McpServerEntry = { name, config: raw as unknown as McpServerConfig, source: filePath, scope: 'global' }
    const timeout = Math.min(typeof raw.timeout === 'number' ? raw.timeout * 1000 : 30000, deadline - Date.now())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeout))
    const client = new McpClient({ name: 'pi-meme', version: '0.0.0', requestTimeoutMs: Math.max(1, timeout) })
    const connection = transport(entry, cwd, undefined)
    const abort = () => {
      void connection.close().catch(() => {})
    }
    controller.signal.addEventListener('abort', abort, { once: true })
    try {
      await client.connect(connection)
      const tools = await client.listTools({ signal: controller.signal })
      const info = client.serverInfo
      lines.push(`${name}: 已连接${info ? `（${info.name} ${info.version}）` : ''}，共 ${tools.length} 个工具`)
    } catch (cause) {
      // 不回显未受信任进程 stderr 或 HTTP 正文，避免将凭据放进诊断消息。
      lines.push(
        `${name}: ${controller.signal.aborted ? '检查超时' : cause instanceof Error && cause.message.startsWith('sandbox-unavailable:') ? cause.message : '连接失败，请检查当前配置授权和会话连接错误'}`,
      )
      failed = true
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', abort)
      await client.close().catch(() => {})
    }
  }
  return { checkedAt, output: lines.join('\n'), exitCode: failed ? 1 : 0, timedOut: Date.now() >= deadline }
}
