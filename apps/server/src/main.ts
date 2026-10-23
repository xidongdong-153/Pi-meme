import { startHostServer } from '@pi-meme/host/server'
import { acquireLocalHost } from '@pi-meme/host/local-host'
import { serverOptions } from './server-options'

const options = await serverOptions(import.meta.url)
const hostname = options.hostname!
const port = options.port!
let server: Awaited<ReturnType<typeof startHostServer>> | undefined
if (['127.0.0.1', 'localhost', '::1'].includes(hostname) && !options.tls) {
  const lease = await acquireLocalHost({
    url: `${options.tls ? 'https' : 'http'}://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`,
    dataRoot: options.dataRoot,
    allowReuse: ![
      process.env.PI_MEME_TOKEN,
      process.env.PI_MEME_TLS_CERT,
      process.env.PI_MEME_WEB_ROOT,
      process.env.PI_MEME_AUTH_MODE,
    ].some((value) => value !== undefined),
    create: () => startHostServer(options),
  })
  if (lease.ownership === 'attached')
    console.log(
      `复用已有 Host：${lease.url}；由 ${lease.status.owner === 'desktop' ? 'Desktop' : 'Server'} 管理；当前命令不接管生命周期`,
    )
  else server = lease.resource
} else server = await startHostServer(options)

if (server) {
  const owned = server
  console.log(`Host 已启动：${owned.url}；数据目录：${owned.host.root}`)
  let stopping = false
  function stop() {
    if (stopping) return
    stopping = true
    void owned
      .dispose()
      .then(() => process.exit(0))
      .catch((cause: unknown) => {
        console.error(`Host 退出失败：${String(cause)}`)
        process.exit(1)
      })
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
