import {
  defaultDevelopmentFrontendPort,
  defaultDevelopmentHostPort,
  hostPort,
  localHostUrl,
} from '../packages/contracts/src/host-runtime'
import { startFrontendServer } from '../packages/host/src/frontend-server'
import { waitForLocalHost } from '../packages/host/src/host-status'
import { readRuntimeSnapshot } from '../packages/host/src/runtime-snapshot'

const root = process.env.PI_MEME_RUNTIME_SNAPSHOT
if (!root) throw new Error('runtime-snapshot-required: Web 开发入口只服务已发布的静态快照')
const snapshot = await readRuntimeSnapshot(root, process.env.PI_MEME_DATA_ROOT)
const upstreamUrl =
  process.env.PI_MEME_HOST_URL ?? localHostUrl(hostPort(process.env.PI_MEME_PORT, defaultDevelopmentHostPort))
const host = await waitForLocalHost(upstreamUrl, { timeoutMs: 120000 })
const frontend = await startFrontendServer({
  upstreamUrl,
  hostId: host.hostId,
  staticDirectory: snapshot.staticDirectory,
  runtimeSnapshotRoot: snapshot.root,
  port: defaultDevelopmentFrontendPort,
})
console.log(`Web 已启动：${frontend.url}；固定快照：${snapshot.root}`)
let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  void frontend.dispose().then(
    () => process.exit(0),
    () => process.exit(1),
  )
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
