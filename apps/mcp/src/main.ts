import process from 'node:process'
import { parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfiguration } from './config'
import { HostRegistry } from './hosts'
import { startHttpServer } from './http-server'
import { createMcpServer } from './tools'

const help = `Pi meme MCP

node apps/mcp/dist/main.js [--config /absolute/path/config.json] [--transport http|stdio]

默认 HTTP：127.0.0.1:4311/mcp；独立 Bearer 令牌来自 PI_MEME_MCP_TOKEN（至少 32 字符）。
默认上游：PI_MEME_HOST_URL 或 http://127.0.0.1:3185；Host 令牌来自 PI_MEME_HOST_TOKEN。
多 Host 和项目范围使用 --config；配置只引用 tokenEnv，不保存凭据。
写操作默认关闭；PI_MEME_MCP_ALLOW_WRITE=true 开启，项目登记另需
PI_MEME_MCP_ALLOW_PROJECT_REGISTRATION=true。stdio 请直接启动 node，不经 pnpm 输出协议。
`

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      transport: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    process.stderr.write(help)
    return
  }
  const config = await loadConfiguration({ file: values.config, transport: values.transport })
  const registry = new HostRegistry(config)
  let closeTransport: () => Promise<void>
  try {
    if (config.transport === 'stdio') {
      const server = createMcpServer(registry)
      await server.connect(new StdioServerTransport())
      closeTransport = () => server.close()
    } else {
      const http = await startHttpServer(config, registry)
      closeTransport = () => http.dispose()
      console.error(
        `Pi meme MCP 已监听 ${http.url}；上游按工具调用连接；写操作${registry.hasWrites ? '已授权' : '关闭'}`,
      )
    }
  } catch (cause) {
    await registry.dispose()
    throw cause
  }
  let closing: Promise<void> | undefined
  function stop() {
    closing ??= (async () => {
      await closeTransport()
      await registry.dispose()
    })()
    return closing
  }
  function exit() {
    const deadline = setTimeout(() => process.exit(1), 10000)
    deadline.unref()
    void stop()
      .then(() => process.exit(0))
      .catch(() => {
        console.error('Pi meme MCP 关闭失败')
        process.exit(1)
      })
  }
  process.once('SIGINT', exit)
  process.once('SIGTERM', exit)
  if (config.transport === 'stdio') process.stdin.once('end', exit)
}

await main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : 'Pi meme MCP 启动失败')
  process.exitCode = 1
})
