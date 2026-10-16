import path from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { startHostServer } from '@pi-meme/host/server'

type ParentPort = {
  postMessage: (value: unknown) => void
  on: (event: 'message', callback: (event: { data: unknown }) => void) => void
}
const parent = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
if (!parent) throw new Error('本地 Host 必须由 Electron utilityProcess 启动')
const testCertificate = process.env.PI_MEME_TEST_TLS_CA
if (testCertificate) {
  const dataRoot = process.env.PI_MEME_DATA_ROOT
  if (!dataRoot || !['memory', 'file'].includes(process.env.PI_MEME_TEST_CREDENTIALS ?? ''))
    throw new Error('验收证书只允许在指定数据目录的测试模式中使用')
  const certificatePath = realpathSync(testCertificate)
  const fixtureRoot = path.dirname(realpathSync(dataRoot))
  const temporaryRoot = realpathSync(tmpdir())
  if (!fixtureRoot.startsWith(`${temporaryRoot}${path.sep}`))
    throw new Error('验收证书只允许用于系统临时目录内的 fixture')
  if (!certificatePath.startsWith(`${fixtureRoot}${path.sep}`)) throw new Error('验收证书必须位于临时 fixture 目录')
  setDefaultCACertificates([...getCACertificates('default'), readFileSync(certificatePath, 'utf8')])
}
void startHostServer({
  dataRoot: process.env.PI_MEME_DATA_ROOT,
  testCredentials: process.env.PI_MEME_TEST_CREDENTIALS === 'memory',
  staticDirectory: path.join(__dirname, '../renderer/main_window'),
  frontendUrl: process.env.PI_MEME_FRONTEND_URL,
  workerPath: path.join(__dirname, 'session-worker.js'),
  builtinSkillsSource: path.join(__dirname, 'skills'),
})
  .then((server) => {
    parent.postMessage({ type: 'ready', url: server.url, hostId: server.host.hostId })
    parent.on('message', ({ data }) => {
      const value = data as { type?: string; id?: string; url?: string; token?: string; hostId?: string }
      if (
        value.type === 'service:register' ||
        value.type === 'connection:get' ||
        value.type === 'connection:list' ||
        value.type === 'connection:set' ||
        value.type === 'connection:remove'
      ) {
        void (async () => {
          if (value.type === 'service:register') {
            if (typeof value.url !== 'string' || typeof value.token !== 'string') throw new Error('服务登记参数无效')
            return server.remotes.register(value.url, value.token)
          }
          if (value.type === 'connection:list') return server.host.connections.list()
          if (typeof value.url !== 'string') throw new Error('Host 地址无效')
          if (value.type === 'connection:get') return server.host.connections.read(value.url)
          if (value.type === 'connection:remove') {
            const service = server.remotes.list().find((service) => service.address === new URL(value.url!).origin)
            if (service) return server.remotes.remove(service.id)
            return server.host.connections.remove(value.url)
          }
          if (typeof value.token !== 'string' || typeof value.hostId !== 'string') throw new Error('远程 Host 凭据无效')
          await server.host.connections.save({ url: value.url, token: value.token, hostId: value.hostId })
        })().then(
          (result) => parent.postMessage({ type: 'connection:result', id: value.id, result }),
          (cause: unknown) =>
            parent.postMessage({
              type: 'connection:result',
              id: value.id,
              error:
                value.type === 'service:register'
                  ? serviceRegistrationError(cause)
                  : '无法保存或读取远程 Host 凭据，请检查 auth.json 和数据目录权限',
            }),
        )
      }
      if (value.type === 'maintenance:prepare') {
        try {
          if (value.hostId !== server.host.hostId) throw new Error('维护目标 Host 身份不匹配')
          server.remotes.assertIdle()
          server.host.prepareMaintenance()
          server.remotes.prepareMaintenance()
          parent.postMessage({ type: 'connection:result', id: value.id })
        } catch (cause) {
          parent.postMessage({
            type: 'connection:result',
            id: value.id,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        }
      }
      if (value.type === 'ticket')
        parent.postMessage({ type: 'ticket', id: value.id, token: server.createBootstrapTicket() })
      if (value.type === 'stop')
        void server
          .dispose()
          .then(() => process.exit(0))
          .catch(() => process.exit(1))
    })
  })
  .catch((cause: unknown) => {
    parent.postMessage({ type: 'failed', message: String(cause) })
    process.exit(1)
  })

function serviceRegistrationError(cause: unknown) {
  if (!(cause instanceof Error)) return '远程服务登记失败'
  const source = cause.cause
  const code =
    source && typeof source === 'object' && 'code' in source && typeof source.code === 'string'
      ? source.code
      : undefined
  if (code && /CERT|SELF_SIGNED|ISSUER|TLS/.test(code)) return `远程服务 HTTPS 证书校验失败：${code}`
  if (cause.message === 'fetch failed')
    return code ? `无法连接远程服务：${code}` : '无法连接远程服务，请检查网络和 HTTPS 地址'
  return cause.message.replace(/https?:\/\/\S+/g, '[Host 地址]')
}
