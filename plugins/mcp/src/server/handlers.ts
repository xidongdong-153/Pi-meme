import type { PiRuntime } from '@pi-meme/pi-runtime/runtime'
import type { DeleteMcpServer, SaveMcpServer } from '@pi-meme/contracts/mcp'
import { text } from '@pi-meme/contracts/ipc'
import { object } from '../shared/config'
import type { McpConfigStore } from './config-store'
import { checkMcpServers } from './diagnostics'

export function createMcpHandlers({ pi, store }: { pi: PiRuntime; store: McpConfigStore }) {
  const apply = async (action: () => ReturnType<McpConfigStore['snapshot']>) =>
    pi.idle(async () => {
      const snapshot = await action()
      try {
        await pi.reconnectModels()
      } catch {
        throw new Error('MCP 配置已保存，但 Pi 重连失败；请检查连接错误后重试')
      }
      return snapshot
    }, true)
  const input = (value: unknown) => {
    if (!object(value)) throw new Error('MCP 配置参数无效')
    text(value.revision)
    text(value.name)
    if (value.previousName !== undefined) text(value.previousName)
    return value
  }
  return {
    'mcp:get': () => store.snapshot(),
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
        if (
          connection.sessionKey !== sessionKey ||
          connection.accessMode !== 'full-access' ||
          connection.accessChanging
        )
          throw new Error('仅当前完全权限会话可以检查 MCP 服务')
        return checkMcpServers(store.filePath)
      }, true)
    },
  }
}
