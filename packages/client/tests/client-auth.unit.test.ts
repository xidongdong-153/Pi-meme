import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { HostRpcRequest } from '@pi-meme/contracts/host'
import { HostClient, type ClientOptions } from '../src/host-client'
import { snapshot, FakeSocket, create, tick, withBrowserStorage } from './host-client-fixture'

test('重连只重新读取快照，不重发 prompt，WebSocket 地址不包含令牌', async () => {
  const { client, requests, sockets, socketUrls } = create((request) =>
    request.method === 'pi:snapshot' ? snapshot('A') : null,
  )
  await client.bridge.getConnection()
  await client.connect()
  sockets[0].open()
  await tick()
  await client.bridge.prompt('A', '测试消息')
  sockets[0].close()
  await tick()
  sockets[1].open()
  await tick()
  assert.equal(requests.filter((request) => request.method === 'pi:prompt').length, 1)
  assert.equal(requests.find((request) => request.method === 'pi:prompt')?.sessionId, 'A')
  assert.ok(socketUrls.every((url) => !new URL(url).searchParams.has('token')))
  client.close()
})

test('远程 HTTP 地址被拒绝', () => {
  assert.throws(
    () =>
      new HostClient({
        connection: { url: 'http://example.com', token: '', hostId: '', local: false },
        selectDirectory: async () => null,
      }),
    /HTTPS/,
  )
})

test('空令牌主动认证，401 重新认证后同一消息仅执行一次', async () => {
  let auth = 0
  let attempts = 0
  let executed = 0
  const requestIds: string[] = []
  const client = new HostClient({
    connection: { url: 'http://127.0.0.1:3141', token: '', hostId: 'host-1', local: false },
    selectDirectory: async () => null,
    fetch: (async (url, init) => {
      if (new URL(String(url)).pathname === '/api/auth') {
        auth++
        assert.deepEqual(JSON.parse(String(init?.body)), { token: '' })
        return new Response(JSON.stringify({ hostId: 'host-1' }))
      }
      const request = JSON.parse(String(init?.body)) as HostRpcRequest
      requestIds.push(request.requestId)
      if (++attempts === 1) return new Response('{}', { status: 401 })
      executed++
      return new Response(JSON.stringify({ requestId: request.requestId, hostId: 'host-1' }))
    }) as typeof fetch,
  })
  try {
    await client.bridge.prompt('A', '只发送一次')
    assert.equal(auth, 2)
    assert.equal(attempts, 2)
    assert.equal(executed, 1)
    assert.equal(requestIds[0], requestIds[1])
  } finally {
    client.close()
  }
})

test('连续 401 只重试一次，网络失败不重发消息', async () => {
  for (const networkFailure of [false, true]) {
    let attempts = 0
    const client = new HostClient({
      connection: { url: 'http://127.0.0.1:3141', token: '', hostId: '', local: false },
      selectDirectory: async () => null,
      fetch: (async (url) => {
        if (new URL(String(url)).pathname === '/api/auth') return new Response('{}')
        attempts++
        if (networkFailure) throw new Error('连接已断开')
        return new Response('{}', { status: 401 })
      }) as typeof fetch,
    })
    try {
      await assert.rejects(client.bridge.prompt('A', '消息'), networkFailure ? /没有自动重发/ : /登录已失效/)
      assert.equal(attempts, networkFailure ? 1 : 2)
    } finally {
      client.close()
    }
  }
})

test('多服务代理端点保持本机origin并隔离客户端和相同sessionKey', async () => {
  const urls: string[] = []
  const clients = ['a', 'b'].map(
    (service) =>
      new HostClient({
        connection: { url: `https://${service}.example`, token: '', hostId: service, local: false },
        endpoint: { baseUrl: 'http://127.0.0.1:31415', apiPrefix: `/api/services/${service}` },
        selectDirectory: async () => null,
        fetch: (async (input, init) => {
          const url = String(input)
          urls.push(url)
          if (url.endsWith('/api/auth')) return new Response('{}')
          const request = JSON.parse(String(init?.body)) as HostRpcRequest
          return new Response(
            JSON.stringify({ requestId: request.requestId, hostId: service, result: snapshot('same-key') }),
          )
        }) as typeof fetch,
        createSocket: (url) => {
          urls.push(url)
          return new FakeSocket() as unknown as WebSocket
        },
      }),
  )
  try {
    assert.notEqual(clients[0].clientId, clients[1].clientId)
    await Promise.all(clients.map((client) => client.connect()))
    await Promise.all(clients.map((client) => client.bridge.getSnapshot()))
    assert.ok(urls.every((url) => new URL(url).hostname === '127.0.0.1'))
    for (const client of clients) {
      assert.equal(client.localHost, false)
      assert.ok(urls.some((url) => url.includes(`/api/services/${client.hostId}/api/rpc`)))
      const plugin = `/api/services/${client.hostId}/api/plugins/module.js`
      assert.equal(client.resourceUrl(plugin), `http://127.0.0.1:31415${plugin}`)
    }
  } finally {
    for (const client of clients) client.close()
  }
})

test('浏览器刷新复用Host身份并恢复原选择，storage只保存客户端ID', async () => {
  await withBrowserStorage(async (values) => {
    const selected = new Map<string, string>()
    const handle = (request: HostRpcRequest) => {
      if (request.method === 'pi:switch-session') {
        selected.set(request.clientId, 'B')
        return { cancelled: false, snapshot: snapshot('B') }
      }
      if (request.method === 'pi:snapshot') return snapshot(selected.get(request.clientId) ?? 'A')
      return []
    }
    const first = create(handle, { clientId: undefined })
    let refreshed: ReturnType<typeof create> | undefined
    try {
      await first.client.bridge.getConnection()
      await first.client.bridge.switchSession('/B.jsonl')
      first.client.close()
      refreshed = create(handle, { clientId: undefined })
      assert.equal(refreshed.client.clientId, first.client.clientId)
      assert.equal((await refreshed.client.bridge.getConnection()).sessionKey, 'B')
      assert.deepEqual([...values.values()], [first.client.clientId])
      assert.ok([...values.keys()].every((key) => !key.includes('/B.jsonl')))
    } finally {
      first.client.close()
      refreshed?.client.close()
    }
  })
})

test('客户端身份按Host origin/id及endpoint隔离，显式ID优先且不会覆盖保存值', async () => {
  await withBrowserStorage((values) => {
    const clients: HostClient[] = []
    const build = (options: Partial<ClientOptions> = {}) => {
      const client = create(() => [], { clientId: undefined, ...options }).client
      clients.push(client)
      return client
    }
    try {
      const original = build()
      const explicit = build({ clientId: 'explicit-client' })
      assert.equal(explicit.clientId, 'explicit-client')
      assert.equal(build().clientId, original.clientId)
      const otherOrigin = build({
        connection: { url: 'https://host.example', token: '', hostId: 'host-1', local: false },
      })
      const otherHost = build({
        connection: { url: 'http://127.0.0.1:3141', token: '', hostId: 'host-2', local: false },
      })
      const otherEndpoint = build({ endpoint: { baseUrl: 'http://127.0.0.1:3141', apiPrefix: '/other' } })
      assert.equal(new Set([original, otherOrigin, otherHost, otherEndpoint].map((client) => client.clientId)).size, 4)
      assert.equal(values.size, 4)
    } finally {
      for (const client of clients) client.close()
    }
  })
})

test('Node及不可用sessionStorage继续生成随机身份', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const clients: HostClient[] = []
  const build = () => {
    const client = create(() => [], { clientId: undefined }).client
    clients.push(client)
    return client
  }
  try {
    Reflect.deleteProperty(globalThis, 'window')
    assert.notEqual(build().clientId, build().clientId)
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        get sessionStorage() {
          throw new Error('浏览器禁止storage')
        },
      },
    })
    assert.notEqual(build().clientId, build().clientId)
  } finally {
    for (const client of clients) client.close()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
