import path from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { startHostServer } from '@pi-meme/host/server'
import { errorCode } from '@pi-meme/host/host-status'
import { hostPort } from '@pi-meme/contracts/host-runtime'

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
  port: hostPort(process.env.PI_MEME_PORT),
  owner: 'desktop',
  localAutoLogin: true,
  staticDirectory: path.join(__dirname, '../renderer/main_window'),
  frontendUrl: process.env.PI_MEME_FRONTEND_URL,
  workerPath: path.join(__dirname, 'session-worker.js'),
  builtinSkillsSource: path.join(__dirname, 'skills'),
})
  .then((server) => {
    parent.postMessage({ type: 'ready', url: server.url, hostId: server.host.hostId })
    parent.on('message', ({ data }) => {
      const value = data as { type?: string; id?: string; hostId?: string }
      if (value.type === 'maintenance:prepare') {
        try {
          if (value.hostId !== server.host.hostId) throw new Error('维护目标 Host 身份不匹配')
          server.remotes.assertIdle()
          server.host.prepareMaintenance()
          server.remotes.prepareMaintenance()
          parent.postMessage({ type: 'maintenance:result', id: value.id })
        } catch (cause) {
          parent.postMessage({
            type: 'maintenance:result',
            id: value.id,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        }
      }
      if (value.type === 'stop' && value.hostId === server.host.hostId)
        void server
          .dispose()
          .then(() => process.exit(0))
          .catch(() => process.exit(1))
    })
  })
  .catch((cause: unknown) => {
    parent.postMessage({ type: 'failed', message: String(cause), code: errorCode(cause) })
    process.exit(1)
  })
