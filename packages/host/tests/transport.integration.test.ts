import assert from 'node:assert/strict'
import { test } from 'vitest'
import { request } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { startHostServer, type ServerOptions } from '../src/server'

async function fixture(options: ServerOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-host-transport-'))
  const server = await startHostServer({ dataRoot: root, testCredentials: true, token: 'test-token', ...options })
  const auth = await fetch(`${server.url}/api/auth`, { method: 'POST', body: '{"token":"test-token"}' })
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]
  return {
    root,
    server,
    cookie,
    async dispose() {
      await server.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function send(url: string, cookie: string, bytes: number, method: string, chunked = false) {
  const json = JSON.stringify({ requestId: 'body-test', clientId: 'body-test', method, args: [] })
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: { Cookie: cookie, ...(chunked ? {} : { 'Content-Length': String(bytes) }) },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }))
      },
    )
    req.on('error', reject)
    req.write(json)
    req.end(Buffer.alloc(bytes - Buffer.byteLength(json), 0x20))
  })
}

test('HTTP 路径、方法、JSON 错误与响应头保持现有协议', async () => {
  const originalRequest = globalThis.Request
  const originalResponse = globalThis.Response
  const f = await fixture()
  try {
    assert.equal(globalThis.Request, originalRequest)
    assert.equal(globalThis.Response, originalResponse)
    for (const [pathname, method] of [
      ['/api/snapshot', 'HEAD'],
      ['/api/snapshot', 'OPTIONS'],
      ['/api/snapshot/', 'GET'],
      ['/api/auth', 'GET'],
      ['/api/events?clientId=test', 'GET'],
      ['/api/unknown', 'GET'],
    ]) {
      const response = await fetch(`${f.server.url}${pathname}`, { method, headers: { Cookie: f.cookie } })
      assert.equal(response.status, 404, `${method} ${pathname}`)
      assert.equal(response.headers.get('content-type'), 'application/json')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      if (method !== 'HEAD') assert.deepEqual(await response.json(), { error: 'Host 接口不存在' })
    }
    const invalid = await fetch(`${f.server.url}/api/rpc`, { method: 'POST', headers: { Cookie: f.cookie }, body: '{' })
    assert.equal(invalid.status, 400)
    assert.equal(typeof (await invalid.json()).error, 'string')
    const snapshot = await fetch(`${f.server.url}/api/snapshot?clientId=test`, { headers: { Cookie: f.cookie } })
    assert.equal(snapshot.status, 200)
    assert.equal((await snapshot.json()).hostId, f.server.host.hostId)
  } finally {
    await f.dispose()
  }
})

test('RPC 按客户端协商压缩大响应，保留完整 JSON 与不压缩客户端', async () => {
  const f = await fixture()
  const result = '远程会话历史。'.repeat(20000)
  f.server.host.rpc = async (value) => ({
    requestId: value.requestId,
    hostId: f.server.host.hostId,
    result,
  })
  try {
    for (const encoding of ['gzip', 'identity']) {
      const response = await new Promise<{ encoding?: string; data: Buffer }>((resolve, reject) => {
        const req = request(
          `${f.server.url}/api/rpc`,
          { method: 'POST', headers: { Cookie: f.cookie, 'Accept-Encoding': encoding } },
          (response) => {
            const chunks: Buffer[] = []
            response.on('data', (chunk: Buffer) => chunks.push(chunk))
            response.on('error', reject)
            response.on('end', () =>
              resolve({ encoding: response.headers['content-encoding'], data: Buffer.concat(chunks) }),
            )
          },
        )
        req.on('error', reject)
        req.end(
          JSON.stringify({
            requestId: 'compression-test',
            clientId: 'compression-test',
            method: 'pi:snapshot',
            args: [],
          }),
        )
      })
      assert.equal(response.encoding, encoding === 'gzip' ? 'gzip' : undefined)
      if (encoding === 'gzip') assert.ok(response.data.length < Buffer.byteLength(result) / 10)
      const data = encoding === 'gzip' ? gunzipSync(response.data) : response.data
      assert.deepEqual(JSON.parse(data.toString()), {
        requestId: 'compression-test',
        hostId: f.server.host.hostId,
        result,
      })
    }
  } finally {
    await f.dispose()
  }
})

test('请求体按实际字节限制，32 MiB 以上只允许资源导入与插件安装', { timeout: 20000 }, async () => {
  const f = await fixture()
  f.server.host.rpc = async (value) => ({
    requestId: value.requestId,
    hostId: f.server.host.hostId,
    result: value.method,
  })
  try {
    const url = `${f.server.url}/api/rpc`
    const mib = 1024 * 1024
    assert.equal((await send(url, f.cookie, 32 * mib, 'pi:snapshot')).status, 200)
    const ordinary = await send(url, f.cookie, 32 * mib + 1, 'pi:snapshot', true)
    assert.equal(ordinary.status, 400)
    assert.deepEqual(JSON.parse(ordinary.body), { error: '普通请求内容超过 32 MiB' })
    assert.equal((await send(url, f.cookie, 48 * mib, 'plugins:install-package', true)).status, 200)
    assert.equal((await send(url, f.cookie, 32 * mib + 1, 'resources:import')).status, 200)
    const overflow = await send(url, f.cookie, 48 * mib + 1, 'resources:import', true)
    assert.equal(overflow.status, 400)
    assert.deepEqual(JSON.parse(overflow.body), { error: '请求内容超过大小限制' })
  } finally {
    await f.dispose()
  }
})

async function rejectedSocket(url: string, headers: Record<string, string>) {
  const socket = new WebSocket(url, { headers, handshakeTimeout: 3000 })
  socket.on('error', () => {})
  return new Promise<number>((resolve, reject) => {
    socket.once('open', () => {
      socket.terminate()
      reject(new Error('无效 WebSocket 请求不应建立连接'))
    })
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      socket.terminate()
      resolve(response.statusCode!)
    })
    socket.once('error', reject)
  })
}

test('WebSocket 升级前拒绝未登录、非法来源、未知路径及无效客户端', async () => {
  const f = await fixture()
  const original = f.server.host.subscribe
  let subscriptions = 0
  f.server.host.subscribe = async (...args) => {
    subscriptions++
    return original(...args)
  }
  try {
    const base = f.server.url.replace('http:', 'ws:')
    assert.equal(await rejectedSocket(`${base}/api/events?clientId=test`, {}), 401)
    assert.equal(
      await rejectedSocket(`${base}/api/events?clientId=test`, { Cookie: f.cookie, Origin: 'https://evil.example' }),
      403,
    )
    for (const pathname of ['/api/unknown', '/api/events/', '/outside', '/api/services/invalid/api/events'])
      assert.equal(await rejectedSocket(`${base}${pathname}?clientId=test`, { Cookie: f.cookie }), 404)
    for (const clientId of ['', 'a'.repeat(129)])
      assert.equal(await rejectedSocket(`${base}/api/events?clientId=${clientId}`, { Cookie: f.cookie }), 400)
    assert.equal(subscriptions, 0)
  } finally {
    await f.dispose()
  }
})

test('本机事件释放订阅，连接关闭后才完成的订阅也立即释放', async () => {
  const f = await fixture()
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let subscribed!: () => void
  const started = new Promise<void>((resolve) => {
    subscribed = resolve
  })
  let unsubscribed!: () => void
  const finished = new Promise<void>((resolve) => {
    unsubscribed = resolve
  })
  f.server.host.subscribe = async () => {
    subscribed()
    await pending
    return unsubscribed
  }
  const socket = new WebSocket(`${f.server.url.replace('http:', 'ws:')}/api/events?clientId=test`, {
    headers: { Cookie: f.cookie },
  })
  try {
    await once(socket, 'open')
    await started
    const closed = once(socket, 'close')
    socket.close()
    await closed
    release()
    await finished
  } finally {
    release()
    socket.terminate()
    await f.dispose()
  }
})

test('控制订阅非法参数仍以 1008 关闭，远程两类事件使用底层 ws 连接', async () => {
  const f = await fixture()
  const base = f.server.url.replace('http:', 'ws:')
  try {
    const invalid = new WebSocket(`${base}/api/control/events?clientId=test&subscription=null`, {
      headers: { Cookie: f.cookie },
    })
    const closed = once(invalid, 'close')
    await once(invalid, 'open')
    const [code, reason] = await closed
    assert.equal(code, 1008)
    assert.equal(reason.toString(), '事件订阅参数无效')
    f.server.remotes.events = async (id, clientId, downstream, subscription) => {
      assert.ok(downstream instanceof WebSocket)
      downstream.send(JSON.stringify({ id, clientId, subscription }))
    }
    const id = 'a'.repeat(24)
    for (const control of [false, true]) {
      const input = '{"sessionId":"target"}'
      const socket = new WebSocket(
        `${base}/api/services/${id}/api/${control ? 'control/' : ''}events?clientId=remote&subscription=${encodeURIComponent(input)}`,
        { headers: { Cookie: f.cookie } },
      )
      try {
        const [message] = await once(socket, 'message')
        assert.deepEqual(JSON.parse(message.toString()), {
          id,
          clientId: 'remote',
          ...(control ? { subscription: input } : {}),
        })
      } finally {
        socket.terminate()
      }
    }
  } finally {
    await f.dispose()
  }
})

test('监听失败释放数据锁，dispose 幂等并关闭活动 WebSocket', { timeout: 10000 }, async () => {
  const f = await fixture()
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-host-port-'))
  let reopened: Awaited<ReturnType<typeof startHostServer>> | undefined
  const socket = new WebSocket(`${f.server.url.replace('http:', 'ws:')}/api/events?clientId=test`, {
    headers: { Cookie: f.cookie },
  })
  const opened = once(socket, 'open')
  try {
    await assert.rejects(
      startHostServer({ dataRoot: directory, testCredentials: true, port: Number(new URL(f.server.url).port) }),
      /EADDRINUSE/,
    )
    reopened = await startHostServer({ dataRoot: directory, testCredentials: true })
    await opened
    const closed = once(socket, 'close')
    const disposing = f.server.dispose()
    assert.equal(f.server.dispose(), disposing)
    await disposing
    await closed
    await assert.rejects(fetch(`${f.server.url}/api/auth`))
  } finally {
    socket.terminate()
    await reopened?.dispose()
    await f.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Web 静态文件保留 MIME、import map CSP、SPA fallback 与编码路径检查', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-host-web-'))
  const imports = '{"imports":{"react":"/react.js"}}'
  const html = `<html><script type="importmap">${imports}</script></html>`
  await writeFile(path.join(directory, 'index.html'), html)
  await mkdir(path.join(directory, 'assets'))
  await writeFile(path.join(directory, 'assets/app.js'), 'export const value = 1')
  const f = await fixture({ staticDirectory: directory })
  try {
    const page = await fetch(`${f.server.url}/chat/session`)
    assert.equal(page.status, 200)
    assert.equal(await page.text(), html)
    const hash = createHash('sha256').update(imports).digest('base64')
    assert.ok(page.headers.get('content-security-policy')!.includes(`'sha256-${hash}'`))
    const script = await fetch(`${f.server.url}/assets/app.js`)
    assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(script.headers.get('x-content-type-options'), 'nosniff')
    const invalid = await fetch(`${f.server.url}/%2e%2e%2foutside`)
    assert.equal(invalid.status, 403)
    assert.deepEqual(await invalid.json(), { error: '文件路径无效' })
  } finally {
    await f.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
