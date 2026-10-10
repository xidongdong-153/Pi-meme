import path from 'node:path'
import { existsSync } from 'node:fs'
import { startHostServer } from '@pi-meme/host/server'

type ParentPort = {
  postMessage: (value: unknown) => void
  on: (event: 'message', callback: (event: { data: unknown }) => void) => void
}
const parent = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
if (!parent) throw new Error('本地 Host 必须由 Electron utilityProcess 启动')
void startHostServer({
  dataRoot: process.env.PI_MEME_DATA_ROOT,
  testCredentials: process.env.PI_MEME_TEST_CREDENTIALS === 'memory',
  staticDirectory: path.join(__dirname, '../renderer/main_window'),
  frontendUrl: process.env.PI_MEME_FRONTEND_URL,
  builtinDirectory: existsSync(path.join(__dirname, '../plugins'))
    ? path.join(__dirname, '../plugins')
    : path.resolve(__dirname, '../../../../plugins'),
  workerPath: path.join(__dirname, 'session-worker.js'),
})
  .then((server) => {
    parent.postMessage({ type: 'ready', url: server.url, hostId: server.host.hostId })
    parent.on('message', ({ data }) => {
      const value = data as { type?: string; id?: string }
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
