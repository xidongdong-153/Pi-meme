import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createBotService } from './app.js'

process.env.NODE_ENV ??= import.meta.url.endsWith('.ts') ? 'development' : 'production'
const port = Number(process.env.PI_BOT_PORT ?? 4310)
const hostname = process.env.PI_BOT_HOST ?? '127.0.0.1'
const publicOrigin = process.env.PI_BOT_ORIGIN
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PI_BOT_PORT须为1–65535')
if (publicOrigin) {
  const url = new URL(publicOrigin)
  if (url.origin !== publicOrigin || url.username || url.password || !['https:', 'http:'].includes(url.protocol))
    throw new Error('PI_BOT_ORIGIN须为无路径的完整Origin')
}
if (!['127.0.0.1', 'localhost', '::1'].includes(hostname) && (!publicOrigin || !publicOrigin.startsWith('https://')))
  throw new Error('非回环监听须配置HTTPS的PI_BOT_ORIGIN，并由反向代理提供TLS')
const service = await createBotService({ publicOrigin, port, dataDirectory: process.env.PI_BOT_DATA_DIR })
const root = fileURLToPath(new URL('../../', import.meta.url))
const webRoot = join(root, 'dist', 'web')
let webAvailable = false
try {
  await access(join(webRoot, 'index.html'))
  webAvailable = true
} catch {
  /* 开发模式可独立启动Vite。 */
}
service.app.all('/api/*', (c) =>
  c.json(
    {
      error: {
        code: 'not-found',
        message: '接口不存在',
        retryable: false,
        requestId: c.res.headers.get('X-Request-Id'),
      },
    },
    404,
  ),
)
if (webAvailable) {
  service.app.use('*', serveStatic({ root: webRoot }))
  service.app.all('/assets/*', (c) => c.text('资源不存在', 404))
  service.app.get('*', serveStatic({ root: webRoot, path: 'index.html' }))
}
const server = serve({ fetch: service.app.fetch, hostname, port }, (info) => {
  console.log(`Bots 已就绪：http://${hostname}:${info.port}${webAvailable ? '' : '（Web开发入口：pnpm dev:bot）'}`)
  console.log(`数据目录：${service.store.directory}`)
})
server.once('error', (cause) => {
  console.error(cause.message)
  void service.close().finally(() => {
    process.exitCode = 1
  })
})
let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  if ('closeAllConnections' in server) server.closeAllConnections()
  server.close()
  try {
    await service.close()
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : 'Bots关闭失败')
    process.exitCode = 1
  }
}
process.once('SIGINT', () => {
  void shutdown()
})
process.once('SIGTERM', () => {
  void shutdown()
})
