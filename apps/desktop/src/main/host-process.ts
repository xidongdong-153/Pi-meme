import path from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { startHostServer } from '@pi-meme/host/server'
import { createAppUpdateService } from '@pi-meme/host/app-update'
import { errorCode } from '@pi-meme/host/host-status'
import { hostPort } from '@pi-meme/contracts/host-runtime'
import { createShortcutPreferencesStore } from './shortcut-preferences'
import type { DesktopHostOperation } from './local-host'

declare const __PI_MEME_VERSION__: string

type ParentPort = {
  postMessage: (value: unknown) => void
  on: (event: 'message', callback: (event: { data: unknown }) => void) => void
}
const parent = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
if (!parent) throw new Error('本地服务必须由 Electron utilityProcess 启动')
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
const packaged = !process.argv.includes('--development')
const userData = process.env.PI_MEME_DESKTOP_PREFERENCES
const shortcuts = userData && path.isAbsolute(userData) ? createShortcutPreferencesStore(userData) : undefined
void startHostServer({
  appUpdate: createAppUpdateService({
    kind: 'desktop',
    version: __PI_MEME_VERSION__,
    packaged,
    developmentFeed: packaged ? undefined : process.env.PI_MEME_UPDATE_FEED,
  }),
  dataRoot: process.env.PI_MEME_DATA_ROOT,
  testCredentials: process.env.PI_MEME_TEST_CREDENTIALS === 'memory',
  port: hostPort(process.env.PI_MEME_PORT),
  owner: 'desktop',
  localAutoLogin: true,
  piMigrationShortcuts: shortcuts,
  staticDirectory: path.join(__dirname, '../renderer/main_window'),
  frontendUrl: process.env.PI_MEME_FRONTEND_URL,
  workerPath: path.join(__dirname, 'session-worker.js'),
  builtinSkillsSource: path.join(__dirname, 'skills'),
})
  .then((server) => {
    parent.postMessage({ type: 'ready', url: server.url, hostId: server.host.hostId })
    async function desktopOperation(operation: DesktopHostOperation | undefined, input: unknown) {
      switch (operation) {
        case 'shortcuts:read':
          if (!shortcuts) throw new Error('本机服务不支持读取快捷键配置')
          return shortcuts.read()
        case 'shortcuts:save':
          if (!shortcuts) throw new Error('本机服务不支持保存快捷键配置')
          return shortcuts.save(input)
        case 'migration:scan':
          if (!server.host.piMigration) throw new Error('本机服务不支持从 Pi 迁移')
          return server.host.piMigration.scan()
        case 'migration:apply':
          if (!server.host.piMigration) throw new Error('本机服务不支持从 Pi 迁移')
          return server.host.piMigration.apply(input)
        default:
          throw new Error('未知本机操作')
      }
    }
    parent.on('message', ({ data }) => {
      if (!data || typeof data !== 'object') return
      const value = data as {
        type?: string
        id?: string
        hostId?: string
        operation?: DesktopHostOperation
        input?: unknown
      }
      if (value.type === 'desktop:request' && typeof value.id === 'string') {
        const operation =
          value.hostId === server.host.hostId
            ? desktopOperation(value.operation, value.input)
            : Promise.reject(new Error('操作目标服务身份不匹配'))
        void operation.then(
          (result) => parent.postMessage({ type: 'desktop:result', id: value.id, result }),
          (cause: unknown) =>
            parent.postMessage({
              type: 'desktop:result',
              id: value.id,
              error: cause instanceof Error ? cause.message : '本机操作失败',
            }),
        )
        return
      }
      if (value.type === 'maintenance:prepare') {
        try {
          if (value.hostId !== server.host.hostId) throw new Error('维护目标服务身份不匹配')
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
