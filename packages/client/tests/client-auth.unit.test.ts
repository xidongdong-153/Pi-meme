import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import type { HostControlEvent } from '@pi-meme/contracts/app-host'
import type { HostRpcRequest, PlatformAdapter } from '@pi-meme/contracts/host'
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

test('Host 不可用与认证失败区分，认证身份变化时不发送业务请求', async () => {
  for (const failure of ['unavailable', 'network', 'identity'] as const) {
    let businessRequests = 0
    const client = new HostClient({
      connection: { url: 'http://127.0.0.1:3141', token: '', hostId: 'host-1', local: false },
      selectDirectory: async () => null,
      fetch: (async (url) => {
        if (!String(url).endsWith('/api/auth')) businessRequests++
        if (failure === 'network') throw new Error('连接已断开')
        return failure === 'unavailable'
          ? new Response('{}', { status: 503 })
          : Response.json({ hostId: 'another-host' })
      }) as typeof fetch,
    })
    try {
      await assert.rejects(
        client.bridge.prompt('A', '不应发出'),
        failure === 'identity' ? /身份已变化/ : /Host.*启动|无法连接 Host/,
      )
      assert.equal(businessRequests, 0)
    } finally {
      client.close()
    }
  }
})

function attachmentClient(options: Partial<ClientOptions> = {}) {
  const requests: URL[] = []
  const client = new HostClient({
    connection: { url: 'http://127.0.0.1:3141', token: '', hostId: 'host-1', local: true },
    clientId: 'attachment-client',
    selectDirectory: async () => null,
    fetch: async (input) => {
      const url = new URL(String(input))
      requests.push(url)
      return Response.json({ hostId: 'host-1', result: { name: url.searchParams.get('name'), path: '/uploaded/file' } })
    },
    ...options,
  })
  return { client, requests }
}

function attachmentPlatform(getPathForFile: (file: File) => string): PlatformAdapter {
  return {
    getPathForFile,
    setHostConnection: async () => {},
    getHostConnection: async () => ({ url: 'http://127.0.0.1:3141', token: '', hostId: 'host-1', local: true }),
    chooseDirectory: async () => null,
    getProjectApps: async () => [],
    openProject: async () => {},
    importTheme: async () => null,
    exportTheme: async () => {},
    openPath: async () => {},
  }
}

class AttachmentRequest {
  upload = {
    onprogress: null as ((event: Pick<ProgressEvent, 'lengthComputable' | 'loaded' | 'total'>) => void) | null,
  }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  withCredentials = false
  status = 200
  responseText = JSON.stringify({ hostId: 'host-1', result: { name: 'file.txt', path: '/uploaded/file' } })
  method?: string
  url?: string
  headers = new Map<string, string>()
  body?: Blob
  aborted = false
  static requests: AttachmentRequest[] = []
  static send: (request: AttachmentRequest) => void = () => {}

  constructor() {
    AttachmentRequest.requests.push(this)
  }

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value)
  }

  send(body: Blob) {
    this.body = body
    AttachmentRequest.send(this)
  }

  abort() {
    this.aborted = true
    this.onabort?.()
  }
}

test('上传文件限制为单个 50 MiB，超限在认证和请求前拒绝，临界值和空文件可上传', async () => {
  const { client, requests } = attachmentClient()
  const data = new Blob([])
  Object.defineProperty(data, 'size', { configurable: true, value: 50 * 1024 * 1024 + 1 })
  try {
    await assert.rejects(client.bridge.uploadAttachment('A', { name: 'too-large.bin', data }), /50.*MB/)
    assert.equal(requests.length, 0)
    Object.defineProperty(data, 'size', { value: 50 * 1024 * 1024 })
    const progress: number[] = []
    await client.bridge.uploadAttachment('A', { name: 'limit.bin', data }, undefined, (value) => progress.push(value))
    await client.bridge.uploadAttachment('A', { name: 'empty.txt', data: new Blob([]) })
    assert.equal(requests.filter((url) => url.pathname === '/api/chat/attachments').length, 2)
    assert.deepEqual(progress, [], 'Node fetch 不模拟上传进度')
  } finally {
    client.close()
  }
})

test('仅本机 Desktop 原生文件直接返回路径且不限制大小，剪贴板与远程连接仍上传', async () => {
  const native = new File([], 'native.bin')
  Object.defineProperty(native, 'size', { value: 50 * 1024 * 1024 + 1 })
  const lookup = vi.fn((file: File) => (file === native ? '/local/native.bin' : ''))
  const platform = attachmentPlatform(lookup)
  const local = attachmentClient({ platform })
  const remote = attachmentClient({
    platform,
    connection: { url: 'https://remote.example', token: '', hostId: 'host-1', local: false },
  })
  try {
    assert.deepEqual(await local.client.bridge.uploadAttachment('A', { name: native.name, data: native }), {
      name: 'native.bin',
      path: '/local/native.bin',
    })
    assert.equal(local.requests.length, 0)
    await local.client.bridge.uploadAttachment('A', { name: 'clipboard.png', data: new File([], 'clipboard.png') })
    assert.equal(local.requests.filter((url) => url.pathname === '/api/chat/attachments').length, 1)
    lookup.mockClear()
    await assert.rejects(remote.client.bridge.uploadAttachment('A', { name: native.name, data: native }), /50.*MB/)
    await remote.client.bridge.uploadAttachment('A', { name: 'remote.txt', data: new File([], 'remote.txt') })
    assert.equal(lookup.mock.calls.length, 0)
    assert.equal(remote.requests.filter((url) => url.pathname === '/api/chat/attachments').length, 1)
  } finally {
    local.client.close()
    remote.client.close()
  }
})

test('浏览器附件使用真实 upload 事件，保留代理 endpoint、认证续期与原始文件', async (t) => {
  AttachmentRequest.requests = []
  vi.stubGlobal('XMLHttpRequest', AttachmentRequest)
  t.onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  AttachmentRequest.send = (request) => {
    if (AttachmentRequest.requests.length === 1) {
      request.status = 401
      request.responseText = '{"error":"需要登录 Host"}'
    } else {
      request.upload.onprogress?.({ lengthComputable: false, loaded: 1, total: 0 })
      request.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 })
      request.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 4 })
    }
    request.onload?.()
  }
  let renewed = 0
  const { client, requests } = attachmentClient({
    connection: { url: 'https://remote.example', token: '', hostId: 'host-1', local: false },
    endpoint: {
      baseUrl: 'http://127.0.0.1:3141',
      apiPrefix: '/api/services/remote',
      renewAuthentication: async () => {
        renewed++
      },
    },
  })
  const data = new File(['test'], 'file.txt')
  const progress: number[] = []
  try {
    assert.deepEqual(
      await client.bridge.uploadAttachment('explicit-session', { name: data.name, data }, undefined, (value) =>
        progress.push(value),
      ),
      { name: 'file.txt', path: '/uploaded/file' },
    )
    assert.deepEqual(progress, [25, 100])
    assert.equal(renewed, 1)
    assert.equal(requests.length, 2)
    assert.ok(requests.every((url) => url.pathname === '/api/services/remote/api/auth'))
    assert.equal(AttachmentRequest.requests.length, 2)
    for (const request of AttachmentRequest.requests) {
      const url = new URL(request.url!)
      assert.equal(url.origin, 'http://127.0.0.1:3141')
      assert.equal(url.pathname, '/api/services/remote/api/chat/attachments')
      assert.equal(url.searchParams.get('sessionKey'), 'explicit-session')
      assert.equal(url.searchParams.get('clientId'), 'attachment-client')
      assert.equal(url.searchParams.get('hostId'), 'host-1')
      assert.equal(request.method, 'POST')
      assert.equal(request.headers.get('Content-Type'), 'application/octet-stream')
      assert.equal(request.withCredentials, true)
      assert.equal(request.body, data)
    }
  } finally {
    client.close()
  }
})

test('浏览器上传响应 AbortSignal，失败不自动重试且结束后清理进度监听', async (t) => {
  AttachmentRequest.requests = []
  AttachmentRequest.send = () => {}
  vi.stubGlobal('XMLHttpRequest', AttachmentRequest)
  t.onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  const { client } = attachmentClient()
  const controller = new AbortController()
  const data = new Blob(['test'])
  try {
    const rejected = assert.rejects(
      client.bridge.uploadAttachment('A', { name: 'file.txt', data }, controller.signal),
      { name: 'AbortError' },
    )
    await tick()
    assert.equal(AttachmentRequest.requests.length, 1)
    controller.abort()
    await rejected
    assert.equal(AttachmentRequest.requests[0].aborted, true)
    assert.equal(AttachmentRequest.requests[0].upload.onprogress, null)
    AttachmentRequest.send = (request) => request.onerror?.()
    await assert.rejects(client.bridge.uploadAttachment('A', { name: 'file.txt', data }), /网络|上传失败/)
    assert.equal(AttachmentRequest.requests.length, 2)
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(client.bridge.uploadAttachment('A', { name: 'file.txt', data }, cancelled.signal), {
      name: 'AbortError',
    })
    assert.equal(AttachmentRequest.requests.length, 2)
  } finally {
    client.close()
  }
})

test('暂停阻止RPC、控制接口和上传，恢复后保留会话与事件监听且不重发消息', async () => {
  const { client, requests, sockets } = create((request) => (request.method === 'pi:snapshot' ? snapshot('A') : []))
  const connections: string[] = []
  let changes = 0
  client.bridge.onConnection((connection) => connections.push(connection.sessionKey!))
  client.onServicesChanged(() => changes++)
  try {
    await client.bridge.getConnection()
    await client.connect()
    await client.bridge.prompt('A', '只发送一次')
    client.suspend()
    const count = requests.length
    await assert.rejects(client.connect(), /已暂停/)
    await assert.rejects(client.bridge.prompt('A', '暂停后不发送'), /已暂停/)
    await assert.rejects(client.host.projects.list(), /已暂停/)
    await assert.rejects(client.bridge.uploadAttachment('A', { name: 'file.txt', data: new Blob([]) }), /已暂停/)
    await tick()
    assert.equal(sockets.length, 1)
    assert.equal(requests.length, count)
    sockets[0].message({ hostId: 'host-1', type: 'services-changed' })
    assert.equal(changes, 0)
    await client.resume()
    sockets[1].open()
    await tick()
    sockets[1].message({ hostId: 'host-1', type: 'services-changed' })
    assert.equal(changes, 1)
    assert.equal(connections.at(-1), 'A')
    assert.equal(requests.filter((request) => request.method === 'pi:prompt').length, 1)
    client.close()
    await assert.rejects(client.resume(), /已关闭/)
  } finally {
    client.close()
  }
})

test('控制订阅暂停后不自动重连，恢复复用原监听和最后事件游标', async () => {
  const { client, sockets, socketUrls } = create(() => [])
  const events: HostControlEvent[] = []
  try {
    await client.connect()
    const stop = await client.host.events.subscribe({ sessionId: 'A' }, (event) => events.push(event))
    const event: HostControlEvent = {
      type: 'runtime',
      hostId: 'host-1',
      sessionId: 'A',
      eventId: 'event-1',
      journalEpoch: 'journal-1',
      seq: 7,
      timestamp: new Date().toISOString(),
      value: { reason: '测试事件' },
    }
    sockets[1].message(event)
    assert.equal(events.length, 1)
    client.suspend()
    sockets[1].message({ ...event, seq: 99 })
    await tick()
    assert.equal(sockets.length, 2)
    assert.equal(events.length, 1)
    await client.resume()
    assert.equal(sockets.length, 4)
    const subscription = JSON.parse(new URL(socketUrls[3]).searchParams.get('subscription')!)
    assert.deepEqual(subscription, { sessionId: 'A', after: { journalEpoch: 'journal-1', seq: 7 } })
    sockets[3].message({ ...event, eventId: 'event-2', seq: 8 })
    assert.equal(events.length, 2)
    stop()
    client.suspend()
    await client.resume()
    assert.equal(sockets.length, 5, '已取消的控制订阅不在恢复时重建')
  } finally {
    client.close()
  }
})

test('暂停发生在认证期间时旧认证不能继续发送业务，恢复使用新认证', async () => {
  let finish!: (value: Response) => void
  let auth = 0
  let business = 0
  const client = new HostClient({
    connection: { url: 'http://127.0.0.1:3141', hostId: 'host-1', token: '', local: false },
    selectDirectory: async () => null,
    createSocket: () => new FakeSocket() as unknown as WebSocket,
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname === '/api/auth') {
        if (++auth === 1)
          return new Promise<Response>((resolve) => {
            finish = resolve
          })
        return Response.json({ hostId: 'host-1' })
      }
      business++
      const request = JSON.parse(String(init?.body)) as HostRpcRequest
      return Response.json({ requestId: request.requestId, hostId: 'host-1', result: [] })
    },
  })
  try {
    const earlier = assert.rejects(client.bridge.prompt('A', '不可迟发'), /已变化|已暂停/)
    await tick()
    client.suspend()
    await client.resume()
    finish(Response.json({ hostId: 'host-1' }))
    await earlier
    assert.equal(auth, 2)
    assert.equal(business, 0)
    await client.bridge.prompt('A', '恢复后新消息')
    assert.equal(business, 1)
    assert.equal(auth, 2)
  } finally {
    client.close()
  }
})

test('暂停会取消进行中的浏览器上传且不会在恢复后重放', async (t) => {
  AttachmentRequest.requests = []
  AttachmentRequest.send = () => {}
  vi.stubGlobal('XMLHttpRequest', AttachmentRequest)
  t.onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  const { client } = attachmentClient({ createSocket: () => new FakeSocket() as unknown as WebSocket })
  try {
    const rejected = assert.rejects(
      client.bridge.uploadAttachment('A', { name: 'file.txt', data: new Blob(['test']) }),
      /暂停/,
    )
    await tick()
    client.suspend()
    await rejected
    assert.equal(AttachmentRequest.requests[0].aborted, true)
    await client.resume()
    assert.equal(AttachmentRequest.requests.length, 1)
  } finally {
    client.close()
  }
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
        if (new URL(String(url)).pathname === '/api/auth') return new Response(JSON.stringify({ hostId: 'host-1' }))
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
          if (url.endsWith('/api/auth')) return new Response(JSON.stringify({ hostId: service }))
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
