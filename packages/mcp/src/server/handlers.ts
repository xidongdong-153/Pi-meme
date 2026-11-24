import type { PiRuntime } from '@pi-meme/pi-runtime/runtime'
import { canUseExternalAgentTools } from '@pi-meme/contracts/agent-access'
import type { DeleteMcpServer, SaveMcpServer, McpTarget } from '@pi-meme/contracts/mcp'
import { text } from '@pi-meme/contracts/ipc'
import { object } from '../shared/config'
import type { McpConfigStore } from './config-store'
import { checkMcpServers } from './diagnostics'
import type { McpManagement } from './management'

export function createMcpHandlers(
  { pi, store, configurationChanged }: { pi: PiRuntime; store: McpConfigStore; configurationChanged: () => void },
  manager: McpManagement,
) {
  const apply = async (action: () => ReturnType<McpConfigStore['snapshot']>) => {
    const snapshot = await action()
    configurationChanged()
    return snapshot
  }
  const input = (value: unknown) => {
    if (!object(value)) throw new Error('MCP 配置参数无效')
    text(value.revision)
    text(value.name)
    if (value.previousName !== undefined) text(value.previousName)
    return value
  }
  return {
    'mcp:get': () => store.snapshot(),
    'mcp:catalog': (key?: unknown) => manager.catalog(key as string | undefined),
    'mcp:probe': (target: unknown) => manager.check(target as McpTarget),
    'mcp:enable': (target: unknown, enabled: unknown) => manager.setEnabled(target as McpTarget, enabled as boolean),
    'mcp:login': (target: unknown) => manager.start(target as McpTarget),
    'mcp:login-state': (id: unknown) => manager.state(id),
    'mcp:login-respond': (id: unknown, url: unknown) => manager.respond(id, url),
    'mcp:login-cancel': (id: unknown) => manager.cancel(id),
    'mcp:logout': (target: unknown) => manager.logout(target as McpTarget),
    'mcp:save': (value: unknown) => {
      const parsed = input(value) as unknown as SaveMcpServer
      return apply(() => store.save(parsed))
    },
    'mcp:delete': (value: unknown) => {
      const parsed = input(value) as unknown as DeleteMcpServer
      return apply(() => store.delete(parsed))
    },
    'mcp:check': (sessionKey: unknown) => {
      text(sessionKey)
      return pi.idle(async () => {
        const connection = pi.connection()
        const actor = pi.getSessionContext(sessionKey)
        if (
          connection.sessionKey !== sessionKey ||
          !canUseExternalAgentTools(actor.accessMode, actor.state.activeMode ?? actor.state.mode) ||
          connection.accessChanging
        )
          throw new Error('仅当前完全权限会话可以检查 MCP 服务')
        return checkMcpServers(store.filePath)
      }, true)
    },
  }
}
