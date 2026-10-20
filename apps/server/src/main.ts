import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHostServer, type ServerOptions } from '@pi-meme/host/server'
import { acquireLocalHost } from '@pi-meme/host/local-host'
import { hostPort } from '@pi-meme/contracts/host-runtime'

const certificate = process.env.PI_MEME_TLS_CERT
const key = process.env.PI_MEME_TLS_KEY
if (Boolean(certificate) !== Boolean(key)) throw new Error('HTTPS 证书与私钥必须同时配置')
const directory = path.dirname(fileURLToPath(import.meta.url))
const hostname = process.env.PI_MEME_HOST ?? '127.0.0.1'
const port = hostPort(process.env.PI_MEME_PORT)
const options: ServerOptions = {
  dataRoot: process.env.PI_MEME_DATA_ROOT,
  restrictedNode: process.env.PI_MEME_PLUGIN_NODE || process.execPath,
  restrictedEntry:
    process.env.PI_MEME_PLUGIN_ENTRY ||
    (import.meta.url.endsWith('.js') ? path.join(directory, 'restricted-entry.mjs') : undefined),
  testCredentials: process.env.PI_MEME_TEST_CREDENTIALS === 'memory',
  hostname,
  port,
  owner: 'server',
  token: process.env.PI_MEME_TOKEN,
  localAutoLogin: true,
  staticDirectory: process.env.PI_MEME_WEB_ROOT ?? path.resolve(directory, '../../web/dist'),
  tls: certificate && key ? { cert: await readFile(certificate), key: await readFile(key) } : undefined,
  workerPath:
    process.env.PI_MEME_WORKER_PATH ??
    (import.meta.url.endsWith('.js') ? path.join(directory, 'session-worker.js') : undefined),
  builtinSkillsSource: import.meta.url.endsWith('.js') ? path.join(directory, 'skills') : undefined,
}
let server: Awaited<ReturnType<typeof startHostServer>> | undefined
if (['127.0.0.1', 'localhost', '::1'].includes(hostname) && !options.tls) {
  const lease = await acquireLocalHost({
    url: `${options.tls ? 'https' : 'http'}://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`,
    dataRoot: options.dataRoot,
    allowReuse: ![process.env.PI_MEME_TOKEN, certificate, process.env.PI_MEME_WEB_ROOT].some(
      (value) => value !== undefined,
    ),
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
