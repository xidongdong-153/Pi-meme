import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { test, vi } from 'vitest'
import { HostClient } from '@pi-meme/client/host-client'
import { storeChatAttachment } from '../src/chat-attachments'
import { setup } from './host-server-fixture'

async function temporaryRoot() {
  return realpath(await mkdtemp(path.join(tmpdir(), 'chat-attachments-')))
}

function clientFor(fixture: Awaited<ReturnType<typeof setup>>, endpoint?: { apiPrefix: string; hostId: string }) {
  return new HostClient({
    connection: {
      url: fixture.server.url,
      token: 'test-token',
      hostId: endpoint?.hostId ?? fixture.server.host.hostId,
      local: true,
    },
    endpoint: endpoint ? { baseUrl: fixture.server.url, apiPrefix: endpoint.apiPrefix } : undefined,
    clientId: 'attachment-client',
    selectDirectory: async () => null,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('Cookie', fixture.cookie)
      return fetch(input, { ...init, headers })
    },
  })
}

function attachmentUrl(fixture: Awaited<ReturnType<typeof setup>>, sessionKey: string) {
  const url = new URL('/api/chat/attachments', fixture.server.url)
  url.search = new URLSearchParams({
    clientId: 'attachment-client',
    hostId: fixture.server.host.hostId,
    sessionKey,
    name: 'file.bin',
  }).toString()
  return url
}

async function eventually(check: () => Promise<boolean>) {
  for (let count = 0; count < 200; count++) {
    if (await check()) return
    await delay(10)
  }
  throw new Error('等待附件状态超时')
}

test('附件保留展示名，路径穿越和同名文件不能逃逸或覆盖', async (t) => {
  const root = await temporaryRoot()
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  for (const name of ['../../文档.pdf', '..\\..\\secret.txt', '/tmp/absolute.txt', 'CON', '..', 'report.xlsx']) {
    const first = await storeChatAttachment(root, name, Readable.from(['first']))
    const second = await storeChatAttachment(root, name, Readable.from(['second']))
    assert.equal(first.name, name)
    assert.ok(path.isAbsolute(first.path))
    assert.equal(path.dirname(path.dirname(first.path)), path.join(root, 'attachments'))
    assert.notEqual(first.path, second.path)
    assert.equal(await readFile(first.path, 'utf8'), 'first')
    assert.equal(await readFile(second.path, 'utf8'), 'second')
    assert.equal((await stat(first.path)).mode & 0o777, 0o600)
  }
})

test('新附件允许超过 20 MiB 的原始文件和零字节，不缓存整个输入流', async (t) => {
  const root = await temporaryRoot()
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const empty = await storeChatAttachment(root, 'empty.txt', Readable.from([]))
  assert.equal((await stat(empty.path)).size, 0)
  const chunk = Buffer.alloc(1024 * 1024, 7)
  const file = await storeChatAttachment(
    root,
    'large.bin',
    Readable.from(
      (async function* () {
        for (let count = 0; count < 33; count++) {
          yield chunk
          if (count === 0) {
            await eventually(async () => {
              const directories = await readdir(path.join(root, 'attachments'))
              for (const directory of directories) {
                const candidate = path.join(root, 'attachments', directory, 'file-large.bin')
                if ((await stat(candidate).catch(() => undefined))?.size) return true
              }
              return false
            })
          }
        }
      })(),
    ),
  )
  assert.equal((await stat(file.path)).size, 33 * 1024 * 1024)
  for (const name of [null, '', '  ', 5])
    await assert.rejects(storeChatAttachment(root, name, Readable.from([])), /文件名/)
})

test('附件允许 50 MiB 边界，流式超限后清理半成品', async (t) => {
  const root = await temporaryRoot()
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const chunk = Buffer.alloc(1024 * 1024)
  function source(extraBytes = 0) {
    return Readable.from(
      (function* () {
        for (let count = 0; count < 50; count++) yield chunk
        if (extraBytes) yield Buffer.alloc(extraBytes)
      })(),
    )
  }
  const file = await storeChatAttachment(root, 'boundary.bin', source())
  assert.equal((await stat(file.path)).size, 50 * 1024 * 1024)
  const before = await readdir(path.join(root, 'attachments'))
  await assert.rejects(storeChatAttachment(root, 'oversized.bin', source(1)), /单个上传文件不能超过 50 MB/)
  assert.deepEqual(await readdir(path.join(root, 'attachments')), before)
})

test('附件输入中断或取消后清理随机目录和半成品', async (t) => {
  const root = await temporaryRoot()
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(
    storeChatAttachment(
      root,
      'broken.bin',
      Readable.from(
        (async function* () {
          yield Buffer.alloc(1024)
          throw new Error('上传中断')
        })(),
      ),
    ),
    /上传中断/,
  )
  const controller = new AbortController()
  const source = new Readable({
    read() {
      this.push(Buffer.alloc(1024))
    },
  })
  const uploading = storeChatAttachment(root, 'cancelled.bin', source, controller.signal)
  await eventually(async () => (await readdir(path.join(root, 'attachments'))).length > 0)
  controller.abort()
  await assert.rejects(uploading, { name: 'AbortError' })
  assert.deepEqual(await readdir(path.join(root, 'attachments')), [])
})

test('附件目录不能通过符号链接写入 Host 数据目录之外', async (t) => {
  const root = await temporaryRoot()
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const outside = path.join(root, 'outside')
  await mkdir(outside)
  await symlink(outside, path.join(root, 'attachments'), 'dir')
  await assert.rejects(storeChatAttachment(root, 'file.txt', Readable.from([])), /符号链接/)
  assert.deepEqual(await readdir(outside), [])
})

test('直连客户端二进制上传超过 32 MiB，图片及空文件均不检查类型，保留认证和显式会话校验', async () => {
  const fixture = await setup()
  const client = clientFor(fixture)
  try {
    const key = (await client.bridge.getSnapshot()).connection.sessionKey!
    await client.bridge.newSession()
    const blob = new Blob([new Uint8Array(33 * 1024 * 1024)], { type: 'application/octet-stream' })
    const file = await client.bridge.uploadAttachment(key, { name: 'large.bin', data: blob })
    assert.equal((await stat(file.path)).size, blob.size)
    for (const name of ['image.bmp', 'empty.unknown']) {
      const result = await client.bridge.uploadAttachment(key, { name, data: new Blob([]) })
      assert.equal(result.name, name)
      assert.equal((await stat(result.path)).size, 0)
    }
    const url = attachmentUrl(fixture, key)
    assert.equal((await fetch(url, { method: 'POST', body: 'unauthenticated' })).status, 401)
    for (const [field, value] of [
      ['hostId', 'wrong'],
      ['sessionKey', 'missing'],
      ['clientId', ''],
      ['sessionKey', ''],
    ]) {
      const invalid = new URL(url)
      invalid.searchParams.set(field, value)
      assert.equal(
        (await fetch(invalid, { method: 'POST', headers: { Cookie: fixture.cookie }, body: 'invalid' })).status,
        400,
      )
    }
    const oldRpc = await fixture.rpc(
      'attachment-client',
      'chat:upload-attachment',
      [key, { name: 'old', data: '' }],
      key,
    )
    assert.match(oldRpc.error!.message, /方法不存在/)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(client.bridge.uploadAttachment(key, { name: 'abort', data: blob }, controller.signal), {
      name: 'AbortError',
    })
    assert.equal((await readdir(path.join(fixture.root, 'attachments'))).length, 3)
  } finally {
    client.close()
    await fixture.dispose()
  }
})

test('HTTP 附件超限返回 413，声明大小或分块上传均不能绕过且不留下半成品', async () => {
  const fixture = await setup()
  const client = clientFor(fixture)
  try {
    const key = (await client.bridge.getSnapshot()).connection.sessionKey!
    const url = attachmentUrl(fixture, key)
    const declared = await new Promise<number>((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'POST',
          agent: false,
          headers: { Cookie: fixture.cookie, 'Content-Length': 50 * 1024 * 1024 + 1 },
        },
        (response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode!))
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(declared, 413)
    const chunked = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { Cookie: fixture.cookie } }, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => (body += chunk))
        response.on('end', () => resolve({ status: response.statusCode!, body }))
      })
      req.on('error', reject)
      const chunk = Buffer.alloc(1024 * 1024)
      for (let count = 0; count < 50; count++) req.write(chunk)
      req.end(Buffer.alloc(1))
    })
    assert.equal(chunked.status, 413, chunked.body)
    assert.match(JSON.parse(chunked.body).error, /单个上传文件不能超过 50 MB/)
    assert.deepEqual(await readdir(path.join(fixture.root, 'attachments')), [])
  } finally {
    client.close()
    await fixture.dispose()
  }
})

test('HTTP 上传断开后清理半成品，维护期间拒绝进入上传', async () => {
  const fixture = await setup()
  const client = clientFor(fixture)
  try {
    const key = (await client.bridge.getSnapshot()).connection.sessionKey!
    const req = request(attachmentUrl(fixture, key), { method: 'POST', headers: { Cookie: fixture.cookie } })
    req.on('error', () => {})
    req.write(Buffer.alloc(64 * 1024))
    await eventually(async () => (await readdir(path.join(fixture.root, 'attachments'))).length > 0)
    assert.throws(() => fixture.server.host.prepareMaintenance(), /操作正在执行/)
    req.destroy()
    await eventually(async () => (await readdir(path.join(fixture.root, 'attachments'))).length === 0)
  } finally {
    client.close()
    await fixture.dispose()
  }
})

test('已登记远程服务流式转发超过 32 MiB，401 续期但不重放已消费的流，取消向上游传播', async () => {
  const local = await setup()
  const remote = await setup()
  const originalFetch = globalThis.fetch
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  let rejectOnce = false
  let uploadCalls = 0
  const streams = new Set<unknown>()
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.hostname !== 'attachment.example') return originalFetch(input, init)
    if (url.pathname === '/api/chat/attachments') {
      uploadCalls++
      assert.ok(init?.body instanceof ReadableStream)
      assert.ok(!streams.has(init.body), '不重用已消费的流')
      streams.add(init.body)
      if (rejectOnce) {
        rejectOnce = false
        for await (const chunk of init.body) assert.ok(chunk.byteLength)
        return new Response('{"error":"需要登录 Host"}', { status: 401 })
      }
    }
    const target = new URL(`${url.pathname}${url.search}`, remote.server.url)
    const headers = new Headers(init?.headers)
    headers.set('Origin', remote.server.url)
    return originalFetch(target, { ...init, headers })
  }
  let client: HostClient | undefined
  try {
    const service = await local.server.remotes.register('https://attachment.example', 'test-token')
    client = clientFor(local, { apiPrefix: `/api/services/${service.id}`, hostId: remote.server.host.hostId })
    const key = (await client.bridge.getSnapshot()).connection.sessionKey!
    timeout.mockClear()
    const blob = new Blob([new Uint8Array(33 * 1024 * 1024)])
    const large = await client.bridge.uploadAttachment(key, { name: 'remote.bin', data: blob })
    assert.equal((await stat(large.path)).size, blob.size)
    assert.ok(large.path.startsWith(remote.root))
    assert.deepEqual(await readdir(path.join(local.root, 'attachments')), [])
    assert.ok(!timeout.mock.calls.some(([milliseconds]) => milliseconds === 30000))
    rejectOnce = true
    const renewed = await client.bridge.uploadAttachment(key, { name: 'renewed.txt', data: new Blob(['renewed']) })
    assert.equal(await readFile(renewed.path, 'utf8'), 'renewed')
    assert.equal(uploadCalls, 3)
    const uploadUrl = new URL(`/api/services/${service.id}/api/chat/attachments`, local.server.url)
    uploadUrl.search = attachmentUrl(remote, key).search
    const req = request(uploadUrl, { method: 'POST', headers: { Cookie: local.cookie } })
    req.on('error', () => {})
    req.write(Buffer.alloc(64 * 1024))
    await eventually(async () => (await readdir(path.join(remote.root, 'attachments'))).length > 2)
    req.destroy()
    await eventually(async () => (await readdir(path.join(remote.root, 'attachments'))).length === 2)
    assert.equal((await readdir(path.join(remote.root, 'attachments'))).length, 2)
    assert.equal(local.server.remotes.list()[0].status, 'connected')
    assert.equal(local.server.remotes.list()[0].error, undefined)
  } finally {
    client?.close()
    globalThis.fetch = originalFetch
    timeout.mockRestore()
    await local.dispose()
    await remote.dispose()
  }
})
