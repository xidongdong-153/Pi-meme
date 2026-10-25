import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { createServer as createHttpServer, request } from 'node:http'
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { hostPort, localHostUrl } from '@pi-meme/contracts/host-runtime'
import { acquireLocalHost } from '../src/local-host'
import { readLocalHostStatus, waitForLocalHost } from '../src/host-status'
import { startHostServer } from '../src/server'

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close((cause) => (cause ? reject(cause) : resolve())))
  return address.port
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-shared-host-')))
  const port = await freePort()
  const servers: Array<Awaited<ReturnType<typeof startHostServer>>> = []
  const create = async (listenPort = port) => {
    const server = await startHostServer({
      dataRoot: root,
      port: listenPort,
      testCredentials: true,
      localAutoLogin: true,
      owner: 'desktop',
    })
    servers.push(server)
    return server
  }
  return {
    root,
    port,
    create,
    acquire: () => acquireLocalHost({ url: localHostUrl(port), dataRoot: root, create }),
    async dispose() {
      await Promise.all(servers.map((server) => server.dispose()))
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('本机入口默认端口统一，非法端口被拒绝，0 仅用于显式临时监听', () => {
  assert.equal(hostPort(), 3185)
  assert.equal(localHostUrl(), 'http://127.0.0.1:3185')
  assert.equal(hostPort('0'), 0)
  for (const value of ['', '-1', '65536', '1.2', 'abc']) assert.throws(() => hostPort(value), /PI_MEME_PORT/)
})

test('本机状态探测使用独立连接，服务停机后立即返回未监听', async () => {
  const connections = new Set<Socket>()
  const status = {
    product: 'pi-meme',
    runtimeProtocolVersion: 1,
    hostId: 'fixture',
    instanceId: 'instance',
    dataRoot: path.join(tmpdir(), 'pi-status-fixture'),
    owner: 'server',
  }
  const server = createHttpServer((request, response) => {
    connections.add(request.socket)
    response.end(JSON.stringify(status))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = localHostUrl(address.port)
  try {
    for (let index = 0; index < 4; index++) assert.deepEqual(await readLocalHostStatus(url), status)
    assert.equal(connections.size, 4, '状态探测不能复用可能在 Host 停机时被关闭的连接')
    await new Promise<void>((resolve, reject) => server.close((cause) => (cause ? reject(cause) : resolve())))
    assert.equal(await readLocalHostStatus(url), undefined)
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('本机状态无需 Cookie，但拒绝跨源，不包含凭据', async () => {
  const f = await fixture()
  try {
    const server = await f.create()
    const status = await readLocalHostStatus(server.url)
    assert.deepEqual(status, {
      product: 'pi-meme',
      runtimeProtocolVersion: 1,
      hostId: server.host.hostId,
      instanceId: server.host.instanceId,
      dataRoot: f.root,
      owner: 'desktop',
    })
    assert.ok(!JSON.stringify(status).includes(server.token))
    assert.equal((await fetch(`${server.url}/api/status`, { headers: { Origin: 'https://evil.example' } })).status, 403)
    assert.equal((await fetch(`${server.url}/api/rpc`, { method: 'POST' })).status, 401)
    const forgedHost = await new Promise<number>((resolve, reject) => {
      const call = request(`${server.url}/api/status`, { headers: { Host: 'evil.example' } }, (response) => {
        response.resume()
        resolve(response.statusCode!)
      })
      call.once('error', reject)
      call.end()
    })
    assert.equal(forgedHost, 403)
    const auth = await fetch(`${server.url}/api/auth`, { method: 'POST', headers: { Origin: server.url }, body: '{}' })
    assert.equal(auth.status, 200)
  } finally {
    await f.dispose()
  }
})

test('并发启动只创建一个 Host，其余复用，非拥有方没有停机资源', async () => {
  const f = await fixture()
  try {
    const leases = await Promise.all(Array.from({ length: 4 }, () => f.acquire()))
    assert.equal(leases.filter((lease) => lease.ownership === 'owned').length, 1)
    assert.equal(new Set(leases.map((lease) => lease.status.instanceId)).size, 1)
    for (const lease of leases.filter((lease) => lease.ownership === 'attached')) assert.ok(!('resource' in lease))
    const reused = await f.acquire()
    assert.equal(reused.ownership, 'attached')
    const owned = leases.find((lease) => lease.ownership === 'owned')!
    assert.equal(owned.ownership, 'owned')
    if (owned.ownership === 'owned') await owned.resource.dispose()
    assert.equal(await readLocalHostStatus(localHostUrl(f.port)), undefined)
  } finally {
    await f.dispose()
  }
})

test('目录不一致和显式创建参数不能复用；真实目录别名可复用', async () => {
  const f = await fixture()
  const alias = `${f.root}-alias`
  try {
    await f.create()
    const failCreate = async (): Promise<never> => {
      throw new Error('不应创建第二个 Host')
    }
    await assert.rejects(
      acquireLocalHost({ url: localHostUrl(f.port), dataRoot: `${f.root}/other`, create: failCreate }),
      /不同数据目录/,
    )
    await assert.rejects(
      acquireLocalHost({ url: localHostUrl(f.port), dataRoot: f.root, create: failCreate, allowReuse: false }),
      /新的令牌/,
    )
    await symlink(f.root, alias)
    assert.equal(
      (await acquireLocalHost({ url: localHostUrl(f.port), dataRoot: alias, create: failCreate })).ownership,
      'attached',
    )
    await assert.rejects(waitForLocalHost(localHostUrl(f.port), { hostId: 'another' }), /身份已变化/)
  } finally {
    await rm(alias, { force: true })
    await f.dispose()
  }
})

test('其他程序或不兼容协议占用端口时，不创建第二个 Host', async () => {
  const f = await fixture()
  const base = {
    product: 'pi-meme',
    runtimeProtocolVersion: 1,
    hostId: 'fixture',
    instanceId: 'instance',
    dataRoot: f.root,
    owner: 'desktop',
  }
  let status: Record<string, unknown> = base
  let disconnect = false
  const server = createHttpServer((request, response) => {
    if (disconnect) {
      request.socket.destroy()
      return
    }
    response.end(JSON.stringify(status))
  })
  let created = 0
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    for (const invalid of [{ product: 'other-app' }, { runtimeProtocolVersion: 99 }, { owner: ['desktop'] }]) {
      status = { ...base, ...invalid }
      await assert.rejects(
        acquireLocalHost({
          url: localHostUrl(address.port),
          dataRoot: f.root,
          create: () => {
            created++
            return f.create()
          },
        }),
        /不是兼容/,
      )
    }
    disconnect = true
    await assert.rejects(
      acquireLocalHost({
        url: localHostUrl(address.port),
        dataRoot: f.root,
        create: () => {
          created++
          return f.create()
        },
      }),
      /没有返回有效的 Host 状态/,
    )
    assert.equal(created, 0)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await f.dispose()
  }
})

test.each(['proxy', 'protocol', 'disconnect', 'timeout'])(
  '允许自动换端口时，避开返回 %s 的占用服务并使用实际 Host 地址',
  async (responseMode) => {
    const f = await fixture()
    const occupied = createHttpServer((request, response) => {
      if (responseMode === 'disconnect') request.socket.destroy()
      else if (responseMode === 'proxy') response.writeHead(400).end()
      else if (responseMode !== 'timeout')
        response.end(JSON.stringify({ product: 'pi-meme', runtimeProtocolVersion: 99 }))
    })
    let preferredStarts = 0
    let fallbackStarts = 0
    try {
      await new Promise<void>((resolve) => occupied.listen(f.port, '127.0.0.1', resolve))
      const lease = await acquireLocalHost({
        url: localHostUrl(f.port),
        dataRoot: f.root,
        create: () => {
          preferredStarts++
          return f.create()
        },
        createOnFreePort: () => {
          fallbackStarts++
          return f.create(0)
        },
      })
      assert.equal(lease.ownership, 'owned')
      assert.notEqual(lease.url, localHostUrl(f.port))
      assert.notEqual(new URL(lease.url).port, '0')
      assert.equal((await readLocalHostStatus(lease.url))?.dataRoot, f.root)
      assert.equal(preferredStarts, 0)
      assert.equal(fallbackStarts, 1)
      assert.equal(occupied.listening, true)
      if (responseMode === 'proxy') {
        await assert.rejects(
          acquireLocalHost({
            url: localHostUrl(f.port),
            dataRoot: f.root,
            create: f.create,
            createOnFreePort: () => f.create(0),
          }),
          { code: 'ELOCKED' },
        )
        assert.equal((await readLocalHostStatus(lease.url))?.instanceId, lease.status.instanceId)
      }
    } finally {
      occupied.closeAllConnections()
      await new Promise<void>((resolve) => occupied.close(() => resolve()))
      await f.dispose()
    }
  },
)

test('自动换端口仍优先复用同目录 Host，其他目录的 Host 保持运行', async () => {
  const current = await fixture()
  const other = await fixture()
  let fallbackStarts = 0
  try {
    const host = await current.create()
    const options = {
      url: host.url,
      dataRoot: current.root,
      create: current.create,
      createOnFreePort: () => {
        fallbackStarts++
        return other.create(0)
      },
    }
    assert.equal((await acquireLocalHost(options)).ownership, 'attached')
    assert.equal(fallbackStarts, 0)
    const lease = await acquireLocalHost({ ...options, dataRoot: other.root })
    assert.equal(lease.ownership, 'owned')
    assert.equal(lease.status.dataRoot, other.root)
    assert.notEqual(lease.url, host.url)
    assert.equal(fallbackStarts, 1)
    assert.equal((await readLocalHostStatus(host.url))?.instanceId, host.host.instanceId)
  } finally {
    await other.dispose()
    await current.dispose()
  }
})

test('探测后端口被抢占时自动换端口，启动失败释放的数据锁可重新获取', async () => {
  const f = await fixture()
  const occupied = createHttpServer((_request, response) => response.writeHead(400).end())
  try {
    const lease = await acquireLocalHost({
      url: localHostUrl(f.port),
      dataRoot: f.root,
      create: async () => {
        await new Promise<void>((resolve) => occupied.listen(f.port, '127.0.0.1', resolve))
        return f.create()
      },
      createOnFreePort: () => f.create(0),
    })
    assert.equal(lease.ownership, 'owned')
    assert.notEqual(lease.url, localHostUrl(f.port))
    assert.equal((await readLocalHostStatus(lease.url))?.instanceId, lease.status.instanceId)
    assert.equal(occupied.listening, true)
  } finally {
    occupied.closeAllConnections()
    await new Promise<void>((resolve) => occupied.close(() => resolve()))
    await f.dispose()
  }
})

test('Host 自身启动失败时保留原始错误，不尝试换端口', async () => {
  const f = await fixture()
  const failure = new Error('内置服务初始化失败')
  let fallbackStarts = 0
  try {
    await assert.rejects(
      acquireLocalHost({
        url: localHostUrl(f.port),
        dataRoot: f.root,
        create: async () => {
          throw failure
        },
        createOnFreePort: () => {
          fallbackStarts++
          return f.create(0)
        },
      }),
      (cause) => cause === failure,
    )
    assert.equal(fallbackStarts, 0)
  } finally {
    await f.dispose()
  }
})

test('等待尚未启动的 Host 有超时，不自动创建或重放业务请求', async () => {
  const port = await freePort()
  await assert.rejects(waitForLocalHost(localHostUrl(port), { timeoutMs: 20 }), /Host 未启动/)
  assert.equal(await readLocalHostStatus(localHostUrl(port)), undefined)
})
