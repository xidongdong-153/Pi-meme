import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RemoteServices } from '../src/remote-services'
import { ConnectionCredentialStore } from '../src/connection-credentials'

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-services-'))
  const values = new Map<string, string>()
  const credentials = new ConnectionCredentialStore(
    {
      get: (key) => values.get(key),
      set: (key, value) => {
        values.set(key, value)
      },
      delete: (key) => values.delete(key),
      entries: (prefix = '') => [...values].filter(([key]) => key.startsWith(prefix)),
    },
    async () => {},
  )
  const services = new RemoteServices(credentials, root)
  await services.initialize()
  return { root, credentials, services }
}

test('同主机不同端口隔离凭据和资源地址，401只重试一次且保留请求标识', async () => {
  const { root, credentials, services } = await setup()
  const original = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  let failed = false
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url: url.href, init: init! })
    assert.equal(init?.redirect, 'error')
    assert.ok(init?.signal)
    if (url.pathname === '/api/auth')
      return new Response(JSON.stringify({ hostId: `host-${url.port}` }), {
        headers: { 'Set-Cookie': `pi_meme_session=cookie-${url.port}; HttpOnly` },
      })
    assert.equal((init?.headers as Record<string, string>).Cookie, `pi_meme_session=cookie-${url.port}`)
    assert.equal((init?.headers as Record<string, string>).Origin, url.origin)
    if (!failed) {
      failed = true
      return new Response('{}', { status: 401 })
    }
    const request = JSON.parse(String(init?.body)) as { requestId: string }
    return new Response(
      JSON.stringify({
        requestId: request.requestId,
        hostId: `host-${url.port}`,
        result: [{ id: 'plugin', ui: '/api/plugins/instance/plugin/1/dist/ui.js' }],
      }),
    )
  }) as typeof fetch
  try {
    const one = await services.register('https://same.example:4001', 'one')
    const two = await services.register('https://same.example:4002', 'two')
    assert.notEqual(one.id, two.id)
    assert.equal(credentials.read(one.address)?.token, 'one')
    const body = JSON.stringify({ requestId: 'stable', clientId: 'client', method: 'plugins:list', args: [] })
    const result = await services.request(one.id, '/api/rpc', 'POST', body)
    assert.match(result.data.toString(), new RegExp(`/api/services/${one.id}/api/plugins/`))
    const requests = calls.filter((call) => call.url.endsWith('/api/rpc'))
    assert.equal(requests.length, 2)
    assert.equal(requests[0].init.body, requests[1].init.body)
    await services.request(two.id, '/api/rpc', 'POST', body)
    const cached = await readFile(path.join(root, 'remote-services.json'), 'utf8')
    assert.ok(!cached.includes('cookie-') && !cached.includes('"token"'))
    await assert.rejects(services.request('unknown', '/api/rpc', 'POST', body), /未登记/)
    await assert.rejects(services.request(one.id, 'https://other.example/api/rpc', 'POST', body), /无效/)
  } finally {
    globalThis.fetch = original
    services.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('网络失败不重发，移除阻止进行中的认证恢复Cookie', async () => {
  const { root, services } = await setup()
  const original = globalThis.fetch
  let requests = 0
  let release: (() => void) | undefined
  let pending = false
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith('/api/auth')) {
      if (pending)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      return new Response('{"hostId":"host"}', { headers: { 'Set-Cookie': 'pi_meme_session=secret' } })
    }
    requests++
    throw new Error('网络中断')
  }) as typeof fetch
  try {
    const state = await services.register('https://remote.example', 'token')
    await assert.rejects(services.request(state.id, '/api/rpc', 'POST', '{}'), /网络中断/)
    assert.equal(requests, 1)
    pending = true
    const retry = services.retry(state.id)
    await new Promise<void>((resolve) => setImmediate(resolve))
    await services.remove(state.id)
    release!()
    await assert.rejects(retry, /登记已变化/)
    assert.deepEqual(services.list(), [])
    await assert.rejects(services.request(state.id, '/api/rpc', 'POST', '{}'), /未登记/)
  } finally {
    globalThis.fetch = original
    services.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('损坏摘要缓存保留原文件并保留已登记服务', async () => {
  const { root, credentials } = await setup()
  try {
    await credentials.save({ url: 'https://remote.example', token: 'token', hostId: 'host' })
    await writeFile(path.join(root, 'remote-services.json'), 'broken')
    const services = new RemoteServices(credentials, root)
    await services.initialize()
    assert.equal(services.list().length, 1)
    assert.match(services.list()[0].error!, /缓存无法读取/)
    assert.equal(await readFile(path.join(root, 'remote-services.json'), 'utf8'), 'broken')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
