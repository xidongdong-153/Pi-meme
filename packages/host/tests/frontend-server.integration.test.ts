import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { test } from 'vitest'
import { createNodeHostClient } from '@pi-meme/client/node-host-client'
import { startHostServer } from '../src/server'
import { startFrontendServer } from '../src/frontend-server'
import { readLocalHostStatus } from '../src/host-status'
import { trustPluginFixture } from './plugin-fixture'

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-frontend-')))
  const ui = path.join(root, 'ui')
  await mkdir(ui)
  await writeFile(
    path.join(ui, 'index.html'),
    '<!doctype html><title>随包界面</title><script type="importmap">{}</script>',
  )
  await writeFile(path.join(ui, 'favicon.ico'), 'fake-ico')
  await writeFile(path.join(ui, 'site.webmanifest'), '{}')
  let host = await startHostServer({ dataRoot: path.join(root, 'data'), testCredentials: true, localAutoLogin: true })
  const frontend = await startFrontendServer({
    upstreamUrl: host.url,
    hostId: host.host.hostId,
    staticDirectory: ui,
    readinessTimeoutMs: 30,
  })
  return {
    root,
    frontend,
    get host() {
      return host
    },
    async replace() {
      const port = Number(new URL(host.url).port)
      await host.dispose()
      host = await startHostServer({
        dataRoot: path.join(root, 'other-data'),
        port,
        testCredentials: true,
        localAutoLogin: true,
      })
    },
    async dispose() {
      await frontend.dispose()
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('API-only Host 可服务独立随包界面，同源认证和插件资源正常，关闭界面不停 Host', async () => {
  const f = await fixture()
  try {
    const html = await fetch(f.frontend.url)
    assert.match(await html.text(), /随包界面/)
    assert.match(html.headers.get('content-security-policy')!, /sha256-/)
    const ico = await fetch(`${f.frontend.url}/favicon.ico`)
    assert.equal(ico.status, 200)
    assert.equal(ico.headers.get('content-type'), 'image/x-icon')
    const manifest = await fetch(`${f.frontend.url}/site.webmanifest`)
    assert.equal(manifest.status, 200)
    assert.equal(manifest.headers.get('content-type'), 'application/manifest+json')
    assert.equal((await fetch(`${f.frontend.url}/api/rpc`, { method: 'POST' })).status, 401)
    const client = await createNodeHostClient({
      url: f.frontend.url,
      hostId: f.host.host.hostId,
      token: '',
      clientId: 'desktop',
    })
    try {
      const info = await client.rpc<{ hostId: string; dataRoot: string }>('host:storage-info')
      assert.equal(info.hostId, f.host.host.hostId)
      assert.deepEqual(await client.rpc('host:connections:list'), [])
      const directory = path.join(f.root, 'plugin')
      await mkdir(path.join(directory, 'dist'), { recursive: true })
      await writeFile(
        path.join(directory, 'package.json'),
        JSON.stringify({ name: 'shared-ui-fixture', version: '1.0.0', piMeme: { sdkVersion: 3, ui: 'dist/entry.js' } }),
      )
      await writeFile(path.join(directory, 'dist/entry.js'), 'export const shared = true\n')
      await f.host.host.plugins.loadDirectory(directory)
      await trustPluginFixture(f.host.host.plugins, 'shared-ui-fixture')
      const plugins = await client.rpc<Array<{ id: string; ui: string }>>('plugins:list')
      const resource = plugins.find((plugin) => plugin.id === 'shared-ui-fixture')!.ui
      const auth = await fetch(`${f.frontend.url}/api/auth`, {
        method: 'POST',
        headers: { Origin: f.frontend.url },
        body: '{}',
      })
      assert.equal(auth.status, 200)
      const cookie = auth.headers.get('set-cookie')!.split(';')[0]
      const response = await fetch(new URL(resource, f.frontend.url), {
        headers: { Cookie: cookie, Origin: f.frontend.url },
      })
      assert.equal(response.status, 200)
      assert.match(await response.text(), /shared = true/)
    } finally {
      client.dispose()
    }
    await f.frontend.dispose()
    assert.equal((await readLocalHostStatus(f.host.url))?.hostId, f.host.host.hostId)
  } finally {
    await f.dispose()
  }
})

test('事件 WebSocket 透传 Cookie 和 Origin，非法来源被拒绝', async () => {
  const f = await fixture()
  const sockets: WebSocket[] = []
  try {
    assert.equal((await fetch(f.frontend.url, { headers: { Origin: 'https://evil.example' } })).status, 403)
    const client = await createNodeHostClient({
      url: f.frontend.url,
      token: '',
      hostId: f.host.host.hostId,
      clientId: 'events',
      webSocket: (url, headers) => {
        const socket = new WebSocket(url, { headers })
        sockets.push(socket)
        return socket
      },
    })
    try {
      const unsubscribe = await client.events.subscribe({}, () => {})
      await new Promise<void>((resolve, reject) => {
        sockets[0].once('open', resolve)
        sockets[0].once('error', reject)
      })
      assert.equal(sockets[0].readyState, WebSocket.OPEN)
      unsubscribe()
      const rejected = new WebSocket(`${f.frontend.url.replace('http:', 'ws:')}/api/events?clientId=evil`, {
        headers: { Origin: 'https://evil.example' },
      })
      sockets.push(rejected)
      const status = await new Promise<number>((resolve, reject) => {
        rejected.once('unexpected-response', (_request, response) => {
          response.resume()
          resolve(response.statusCode!)
        })
        rejected.once('error', reject)
      })
      assert.equal(status, 403)
    } finally {
      client.dispose()
    }
  } finally {
    for (const socket of sockets) socket.terminate()
    await f.dispose()
  }
})

test('维护准备后不能通过连接记录 RPC 绕过关闭守卫修改凭据', async () => {
  const f = await fixture()
  const client = await createNodeHostClient({
    url: f.frontend.url,
    token: '',
    hostId: f.host.host.hostId,
    clientId: 'maintenance',
  })
  try {
    await f.host.host.connections.save({ url: 'https://saved.example', hostId: 'saved', token: 'test-token' })
    f.host.remotes.prepareMaintenance()
    await assert.rejects(client.rpc('host:connections:remove', ['https://saved.example']), /正在退出/)
    assert.deepEqual(f.host.host.connections.list(), [{ url: 'https://saved.example', hostId: 'saved' }])
  } finally {
    client.dispose()
    await f.dispose()
  }
})

test('后端停止返回 503；相同端口换成其他 Host 时拒绝认证，不自动接管', async () => {
  const f = await fixture()
  const auth = () =>
    fetch(`${f.frontend.url}/api/auth`, { method: 'POST', headers: { Origin: f.frontend.url }, body: '{}' })
  try {
    await f.host.dispose()
    const stopped = await auth()
    assert.equal(stopped.status, 503)
    assert.match(await stopped.text(), /Host 未启动/)
    await f.replace()
    const replaced = await auth()
    assert.equal(replaced.status, 503)
    assert.match(await replaced.text(), /身份已变化/)
  } finally {
    await f.dispose()
  }
})
