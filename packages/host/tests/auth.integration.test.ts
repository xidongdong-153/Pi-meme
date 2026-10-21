import assert from 'node:assert/strict'
import { test } from 'vitest'
import { request } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import { initEmptyStorageLayout } from '../src/storage/upgrade'
import { startHostServer } from '../src/server'
import { createHost } from '../src/service'

async function root() {
  return mkdtemp(path.join(tmpdir(), 'pi-meme-host-auth-'))
}

test('默认文件存储启动不读取旧凭据，Host 令牌重启后保持且显式令牌覆盖', async () => {
  const directory = await root()
  let legacyReads = 0
  let server: Awaited<ReturnType<typeof startHostServer>> | undefined
  try {
    const options = {
      dataRoot: directory,
      readLegacyCredentials: async () => {
        legacyReads++
        throw new Error('系统取消')
      },
    }
    server = await startHostServer(options)
    const token = server.token
    assert.equal(legacyReads, 0)
    assert.equal(
      JSON.parse(await readFile(path.join(directory, storageLayoutRelativePaths.authFile), 'utf8'))['host:token'],
      token,
    )
    await server.dispose()
    server = await startHostServer(options)
    assert.equal(server.token, token)
    await server.dispose()
    server = await startHostServer({ ...options, token: 'explicit-token' })
    assert.equal(server.token, 'explicit-token')
    assert.equal(
      JSON.parse(await readFile(path.join(directory, storageLayoutRelativePaths.authFile), 'utf8'))['host:token'],
      'explicit-token',
    )
    assert.equal(legacyReads, 0)
  } finally {
    await server?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('不同 Host 的 Cookie 不同名覆盖，共存时各自认证且不能串认证', async () => {
  const directory = await root()
  const servers: Awaited<ReturnType<typeof startHostServer>>[] = []
  try {
    for (const name of ['one', 'two'])
      servers.push(await startHostServer({ dataRoot: path.join(directory, name), testCredentials: true, token: name }))
    const cookies: string[] = []
    const browserCookies = new Map<string, string>()
    for (const server of servers) {
      const response = await fetch(`${server.url}/api/auth`, {
        method: 'POST',
        headers: { Origin: server.url, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: server.token }),
      })
      assert.equal(response.status, 200)
      const cookie = response.headers.get('set-cookie')!.split(';')[0]
      cookies.push(cookie)
      const [name, value] = cookie.split('=')
      browserCookies.set(name, value)
    }
    assert.equal(browserCookies.size, 2, '同域名不同端口的 Host Cookie 不能互相覆盖')
    for (const [index, server] of servers.entries()) {
      const name = cookies[index].split('=')[0]
      assert.equal(name, `pi_meme_session_${createHash('sha256').update(server.host.hostId).digest('hex')}`)
      const authenticate = (cookie: string) =>
        fetch(`${server.url}/api/auth`, { method: 'POST', headers: { Cookie: cookie }, body: '{}' })
      const sharedCookies = [...browserCookies].map(([key, value]) => `${key}=${value}`).join('; ')
      assert.equal((await authenticate(sharedCookies)).status, 200)
      const otherCookie = cookies[1 - index]
      assert.equal((await authenticate(otherCookie)).status, 401)
      assert.equal((await authenticate(`${name}=${otherCookie.split('=')[1]}`)).status, 401)
      assert.equal((await authenticate(`pi_meme_session=${cookies[index].split('=')[1]}`)).status, 401)
    }
  } finally {
    await Promise.all(servers.map((server) => server.dispose()))
    await rm(directory, { recursive: true, force: true })
  }
})

for (const explicitToken of [undefined, 'configured-token']) {
  test(`本机 Web 自动建立 Cookie，显式令牌 ${explicitToken ? '存在' : '缺省'} 均免登录`, async () => {
    const directory = await root()
    const server = await startHostServer({ dataRoot: directory, localAutoLogin: true, token: explicitToken })
    try {
      const auth = await fetch(`${server.url}/api/auth`, {
        method: 'POST',
        headers: { Origin: server.url, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: '' }),
      })
      assert.equal(auth.status, 200)
      assert.match(auth.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/)
      const cookie = auth.headers.get('set-cookie')!.split(';')[0]
      const reuse = await fetch(`${server.url}/api/auth`, { method: 'POST', headers: { Cookie: cookie }, body: '{}' })
      assert.equal(reuse.status, 200)
      const invalid = await fetch(`${server.url}/api/auth`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({ token: 'wrong' }),
      })
      assert.equal(invalid.status, 401)
      assert.equal((await fetch(`${server.url}/api/rpc`, { method: 'POST' })).status, 401)
      const rpc = await fetch(`${server.url}/api/rpc`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({ requestId: 'read', clientId: 'local', method: 'pi:connection', args: [] }),
      })
      assert.equal(rpc.status, 200)
      assert.equal((await rpc.json()).error, undefined)
    } finally {
      await server.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('未启用本机自动登录时拒绝空令牌，非法来源和伪造转发头不能自动登录', async () => {
  const directory = await root()
  let server = await startHostServer({ dataRoot: directory })
  try {
    const send = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = request(`${server.url}/api/auth`, { method: 'POST', headers }, (response) => {
          response.resume()
          resolve(response.statusCode!)
        })
        req.on('error', reject)
        req.end('{}')
      })
    assert.equal(await send({ Origin: server.url }), 401)
    await server.dispose()
    server = await startHostServer({ dataRoot: directory, localAutoLogin: true })
    const invalidHeaders: Record<string, string>[] = [
      {},
      { Origin: 'null' },
      { Origin: 'https://evil.example' },
      { Origin: 'http://localhost:9999' },
      { Host: 'evil.example', Origin: 'http://evil.example' },
      { 'X-Forwarded-Host': 'localhost', 'X-Forwarded-For': '127.0.0.1', Origin: 'https://evil.example' },
    ]
    for (const headers of invalidHeaders) assert.notEqual(await send(headers), 200)
    const proxyOrigin = 'http://localhost:5173'
    assert.equal(await send({ Host: 'localhost:5173', Origin: proxyOrigin }), 200)
  } finally {
    await server.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('旧钥匙串仅在手动导入时读取，取消不会改变文件，已有键保留', async () => {
  const directory = await root()
  await initEmptyStorageLayout(directory)
  let cancelled = true
  let reads = 0
  const file = path.join(directory, storageLayoutRelativePaths.authFile)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ 'model-provider:existing': 'current' }))
  const host = await createHost({
    dataRoot: directory,
    readLegacyCredentials: async () => {
      reads++
      if (cancelled) throw new Error('用户取消钥匙串读取')
      return [
        ['model-provider:existing', 'old'],
        ['mcp-oauth:server', 'legacy'],
      ]
    },
  })
  const rpc = () =>
    host.rpc({ requestId: crypto.randomUUID(), clientId: 'local', method: 'host:import-keychain', args: [] })
  try {
    assert.equal(reads, 0)
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const busy = host.pi.idle(async () => {
      entered()
      await pending
    }, true)
    await started
    try {
      assert.match((await rpc()).error!.message, /正在运行/)
      assert.equal(reads, 0, '忙碌时不读取旧钥匙串')
    } finally {
      release()
      await busy
    }
    const before = await readFile(file, 'utf8')
    assert.match((await rpc()).error!.message, /取消/)
    assert.equal(await readFile(file, 'utf8'), before)
    cancelled = false
    const imported = await rpc()
    assert.equal(imported.error, undefined)
    assert.deepEqual(imported.result, { imported: 1, skipped: 1 })
    assert.equal(host.credentials.get('model-provider:existing'), 'current')
    assert.equal(host.credentials.get('mcp-oauth:server'), 'legacy')
    assert.deepEqual((await rpc()).result, { imported: 0, skipped: 2 })
  } finally {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('远程凭据由 Host 持久化，列表不含令牌，移除后重启不恢复', async () => {
  const directory = await root()
  let host = await createHost({ dataRoot: directory })
  try {
    await host.connections.save({ url: 'https://host.example/path', hostId: 'remote-id', token: 'private-token' })
    assert.deepEqual(host.connections.list(), [{ url: 'https://host.example', hostId: 'remote-id' }])
    await host.dispose()
    host = await createHost({ dataRoot: directory })
    assert.equal(host.connections.read('https://host.example')!.token, 'private-token')
    await assert.rejects(host.connections.save({ url: 'http://host.example', hostId: 'bad', token: 'bad' }), /HTTPS/)
    assert.equal(host.connections.read('https://host.example')!.token, 'private-token')
    await host.connections.remove('https://host.example')
    await host.dispose()
    host = await createHost({ dataRoot: directory })
    assert.deepEqual(host.connections.list(), [])
  } finally {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
