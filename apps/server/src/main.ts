import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHostServer } from '@pi-meme/host/server'

const certificate = process.env.PI_MEME_TLS_CERT
const key = process.env.PI_MEME_TLS_KEY
if (Boolean(certificate) !== Boolean(key)) throw new Error('HTTPS 证书与私钥必须同时配置')
const directory = path.dirname(fileURLToPath(import.meta.url))
const server = await startHostServer({
  dataRoot: process.env.PI_MEME_DATA_ROOT,
  testCredentials: process.env.PI_MEME_TEST_CREDENTIALS === 'memory',
  hostname: process.env.PI_MEME_HOST ?? '127.0.0.1',
  port: Number(process.env.PI_MEME_PORT ?? '31415'),
  token: process.env.PI_MEME_TOKEN,
  localAutoLogin: true,
  staticDirectory: process.env.PI_MEME_WEB_ROOT ?? path.resolve(directory, '../../web/dist'),
  tls: certificate && key ? { cert: await readFile(certificate), key: await readFile(key) } : undefined,
  workerPath:
    process.env.PI_MEME_WORKER_PATH ??
    (import.meta.url.endsWith('.js') ? path.join(directory, 'session-worker.js') : undefined),
})
console.log(`Host 已启动：${server.url}；数据目录：${server.host.root}`)
if (!process.env.PI_MEME_TOKEN) console.log(`本次访问令牌：${server.token}`)
let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  void server
    .dispose()
    .then(() => process.exit(0))
    .catch((cause: unknown) => {
      console.error(`Host 退出失败：${String(cause)}`)
      process.exit(1)
    })
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
