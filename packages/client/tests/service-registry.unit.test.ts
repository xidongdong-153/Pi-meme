import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { HostRpcRequest, HostService } from '@pi-meme/contracts/host'
import type { SshConnection } from '@pi-meme/contracts/ssh-connections'
import { HostClient } from '../src/host-client'
import { HostServiceRegistry } from '../src/service-registry'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

class RegistrySocket extends EventTarget {
  close() {
    this.dispatchEvent(new Event('close'))
  }
  servicesChanged() {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify({ hostId: 'local-host', type: 'services-changed' }) }),
    )
  }
}

function sshRegistry() {
  const service: HostService = {
    id: '0123456789abcdef01234567',
    hostId: 'ssh-host',
    address: 'http://ssh-0123456789abcdef01234567.invalid',
    local: false,
    name: '远端开发',
    transport: 'ssh',
    enabled: false,
    phase: 'paused',
    status: 'disconnected',
    projects: [{ cwd: '/cached', name: '缓存项目', lastSelectedAt: '2026-01-01' }],
  }
  const profile: SshConnection = {
    id: service.id,
    name: '远端开发',
    target: 'development',
    hostPort: 31415,
    hasToken: true,
    enabled: false,
    phase: 'paused',
  }
  const source = {
    services: [service],
    readServices: async (): Promise<HostService[]> => structuredClone(source.services),
    projects: async (): Promise<unknown[]> => [{ cwd: '/live', name: '实时项目', lastSelectedAt: '2026-01-02' }],
  }
  const socket = new RegistrySocket()
  const localRequests: HostRpcRequest[] = []
  const remoteRequests: URL[] = []
  const local = new HostClient({
    connection: { url: 'http://127.0.0.1:31415', hostId: 'local-host', token: '', local: true },
    selectDirectory: async () => null,
    createSocket: () => socket as unknown as WebSocket,
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname === '/api/auth') return Response.json({ hostId: 'local-host' })
      const request = JSON.parse(String(init?.body)) as HostRpcRequest
      localRequests.push(request)
      let result: unknown = []
      if (request.method === 'host:services:list') result = await source.readServices()
      else if (request.method === 'host:ssh:list') result = [profile]
      else if (request.method === 'host:ssh:save') result = profile
      else if (request.method === 'host:ssh:enabled') result = { ...profile, enabled: request.args[1] }
      else if (request.method === 'pi:sessions') result = { projects: [], recents: [], pinnedPaths: [] }
      return Response.json({ requestId: request.requestId, hostId: 'local-host', result })
    },
  })
  const registry = new HostServiceRegistry(local, {
    baseUrl: 'http://127.0.0.1:31415',
    selectDirectory: async () => null,
    createSocket: () => new RegistrySocket() as unknown as WebSocket,
    fetch: async (input, init) => {
      const url = new URL(String(input))
      remoteRequests.push(url)
      if (url.pathname.endsWith('/api/auth')) return Response.json({ hostId: 'ssh-host' })
      const request = JSON.parse(String(init?.body)) as HostRpcRequest
      const result =
        request.method === 'workspace:projects'
          ? await source.projects()
          : { projects: [], recents: [], pinnedPaths: [] }
      return Response.json({ requestId: request.requestId, hostId: 'ssh-host', result })
    },
  })
  return { registry, local, socket, source, service, profile, localRequests, remoteRequests }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10))

function createRegistry() {
  const source = {
    projects: async (): Promise<unknown[]> => [],
    authenticate: async () => Response.json({ hostId: 'host-1' }),
  }
  const socket = new EventTarget() as EventTarget & { close: () => void }
  socket.close = () => socket.dispatchEvent(new Event('close'))
  const local = new HostClient({
    connection: { url: 'http://127.0.0.1:3141', hostId: 'host-1', token: '', local: true },
    selectDirectory: async () => null,
    createSocket: () => socket as unknown as WebSocket,
    fetch: async (url, init) => {
      if (new URL(String(url)).pathname === '/api/auth') return source.authenticate()
      const request = JSON.parse(String(init?.body)) as HostRpcRequest
      const result =
        request.method === 'workspace:projects'
          ? await source.projects()
          : request.method === 'pi:sessions'
            ? { projects: [], recents: [], pinnedPaths: [] }
            : []
      return Response.json({ requestId: request.requestId, hostId: 'host-1', result })
    },
  })
  const registry = new HostServiceRegistry(local, {
    baseUrl: 'http://127.0.0.1:3141',
    selectDirectory: async () => null,
  })
  return { registry, source }
}

test('未验证SSH配置只经入口RPC读取和保存，不创建HostService或远端客户端', async () => {
  const { registry, source, remoteRequests, profile, localRequests } = sshRegistry()
  source.services = []
  try {
    await registry.initialize()
    assert.deepEqual(await registry.ssh.list(), [profile])
    const input = { name: '远端开发', target: 'development', hostPort: 31415 }
    await registry.ssh.save(input)
    assert.equal(registry.list().length, 1)
    assert.equal(remoteRequests.length, 0)
    assert.throws(() => registry.get(profile.id), /不存在/)
    const saved = localRequests.find((request) => request.method === 'host:ssh:save')!
    assert.deepEqual(saved.args, [input])
  } finally {
    registry.close()
  }
})

for (const phase of ['paused', 'action-required', 'retrying'] as const) {
  test(`SSH ${phase} 初始化和刷新不尝试认证，服务摘要与Host阶段保留`, async () => {
    const { registry, source, service, remoteRequests } = sshRegistry()
    source.services = [{ ...service, enabled: phase !== 'paused', phase, error: '需要处理连接' }]
    try {
      await registry.initialize()
      await registry.refresh(service.id)
      assert.equal(remoteRequests.length, 0)
      assert.equal(registry.list()[1].phase, phase)
      assert.equal(registry.list()[1].projects[0].cwd, '/cached')
      assert.equal(registry.list()[1].error, '需要处理连接')
      await assert.rejects(registry.get(service.id).bridge.prompt('A', '不能偷偷连接'), /已暂停/)
      assert.equal(remoteRequests.length, 0)
    } finally {
      registry.close()
    }
  })
}

test('SSH服务变更只恢复新就绪服务，不每次刷新所有服务或覆盖Host状态', async () => {
  const { registry, local, socket, source, service, remoteRequests } = sshRegistry()
  try {
    await local.connect()
    await registry.initialize()
    source.services = [{ ...service, enabled: true, phase: 'connected', status: 'connected' }]
    socket.servicesChanged()
    await settle()
    assert.equal(registry.list()[1].status, 'connected')
    assert.equal(registry.list()[1].projects[0].cwd, '/live')
    const count = remoteRequests.length
    socket.servicesChanged()
    await settle()
    assert.equal(remoteRequests.length, count, '重复服务事件不重读全部服务摘要')
    source.services = [{ ...service, enabled: true, phase: 'action-required', error: 'Host 令牌已失效' }]
    socket.servicesChanged()
    await settle()
    await assert.rejects(registry.get(service.id).bridge.getProjects(), /已暂停/)
    assert.equal(registry.list()[1].phase, 'action-required')
    assert.equal(registry.list()[1].error, 'Host 令牌已失效')
  } finally {
    registry.close()
  }
})

test('摘要刷新尚未完成也能接收暂停事件，旧成功结果不覆盖暂停或需要处理状态', async () => {
  const { registry, local, socket, source, service } = sshRegistry()
  const projects = deferred<unknown[]>()
  const started = deferred<void>()
  try {
    await local.connect()
    await registry.initialize()
    source.projects = () => {
      started.resolve()
      return projects.promise
    }
    source.services = [{ ...service, enabled: true, phase: 'connected', status: 'connected' }]
    socket.servicesChanged()
    await started.promise
    source.services = [{ ...service, enabled: false, phase: 'paused', error: '用户已暂停' }]
    socket.servicesChanged()
    await settle()
    assert.equal(registry.list()[1].phase, 'paused')
    projects.resolve([{ cwd: '/stale', name: '过期项目', lastSelectedAt: '2026-01-03' }])
    await settle()
    assert.equal(registry.list()[1].phase, 'paused')
    assert.equal(registry.list()[1].status, 'disconnected')
    assert.equal(registry.list()[1].error, '用户已暂停')
    assert.equal(registry.list()[1].projects[0].cwd, '/cached')
  } finally {
    projects.resolve([])
    registry.close()
  }
})

test('服务清单事件合并单次在途读取，并在变更期间再读一次最新状态', async () => {
  const { registry, local, socket, source, service, localRequests } = sshRegistry()
  const earlier = deferred<HostService[]>()
  const started = deferred<void>()
  try {
    await local.connect()
    await registry.initialize()
    const count = localRequests.filter((request) => request.method === 'host:services:list').length
    let reads = 0
    source.readServices = async () => {
      if (++reads === 1) {
        started.resolve()
        return earlier.promise
      }
      return [{ ...service, phase: 'action-required', enabled: true, error: '身份已变化' }]
    }
    socket.servicesChanged()
    await started.promise
    for (let i = 0; i < 5; i++) socket.servicesChanged()
    assert.equal(reads, 1)
    earlier.resolve([{ ...service, phase: 'paused' }])
    await settle()
    assert.equal(reads, 2)
    assert.equal(localRequests.filter((request) => request.method === 'host:services:list').length, count + 2)
    assert.equal(registry.list()[1].phase, 'action-required')
  } finally {
    earlier.resolve([])
    registry.close()
  }
})

test('SSH移除走SSH管理RPC并清理客户端，HTTPS不会因此改变通用接口', async () => {
  const { registry, source, service, localRequests } = sshRegistry()
  try {
    await registry.initialize()
    source.services = []
    await registry.remove(service.id)
    assert.equal(registry.list().length, 1)
    assert.throws(() => registry.get(service.id), /不存在/)
    assert.ok(localRequests.some((request) => request.method === 'host:ssh:remove'))
    assert.ok(localRequests.every((request) => request.method !== 'host:services:remove'))
  } finally {
    registry.close()
  }
})

test('已连接服务刷新摘要期间保留可用状态和已有列表', async () => {
  const { registry, source } = createRegistry()
  try {
    await registry.refresh('local')
    const previous = registry.list()[0].sessions
    const pending = deferred<unknown[]>()
    source.projects = () => pending.promise
    const refreshing = registry.refresh('local')
    try {
      assert.equal(registry.list()[0].status, 'connected')
      assert.equal(registry.list()[0].sessions, previous)
    } finally {
      pending.resolve([])
      await refreshing
    }
  } finally {
    registry.close()
  }
})

test('摘要读取失败不将已连接服务标记断线，保留错误供诊断', async () => {
  const { registry, source } = createRegistry()
  try {
    await registry.refresh('local')
    const previous = registry.list()[0].sessions
    source.projects = async () => {
      throw new Error('项目摘要读取暂时失败')
    }
    await assert.rejects(registry.refresh('local'), /项目摘要读取暂时失败/)
    assert.equal(registry.list()[0].status, 'connected')
    assert.equal(registry.list()[0].sessions, previous)
    assert.match(registry.list()[0].error!, /项目摘要读取暂时失败/)
  } finally {
    registry.close()
  }
})

test('初始化摘要失败不污染本地服务可用状态', async () => {
  const { registry, source } = createRegistry()
  try {
    source.projects = async () => {
      throw new Error('初始化摘要读取失败')
    }
    await registry.initialize()
    assert.equal(registry.list()[0].status, 'connected')
    assert.match(registry.list()[0].error!, /初始化摘要读取失败/)
  } finally {
    registry.close()
  }
})

test('连接自身失败仍标记断线并保留错误，后续刷新可恢复', async () => {
  const { registry, source } = createRegistry()
  try {
    source.authenticate = async () => Response.json({ error: '测试 Host 尚未就绪' }, { status: 503 })
    await assert.rejects(registry.refresh('local'), /测试 Host 尚未就绪/)
    assert.equal(registry.list()[0].status, 'disconnected')
    assert.equal(registry.list()[0].error, '测试 Host 尚未就绪')
    source.authenticate = async () => Response.json({ hostId: 'host-1' })
    await registry.refresh('local')
    assert.equal(registry.list()[0].status, 'connected')
    assert.equal(registry.list()[0].error, undefined)
  } finally {
    registry.close()
  }
})

for (const result of ['失败', '成功'] as const) {
  test(`较早摘要刷新迟到${result}不覆盖最新刷新结果`, async () => {
    const { registry, source } = createRegistry()
    const pending = deferred<unknown[]>()
    const started = deferred<void>()
    try {
      await registry.refresh('local')
      source.projects = () => {
        started.resolve()
        return pending.promise
      }
      const earlier = registry.refresh('local')
      const settled = result === '失败' ? assert.rejects(earlier, /旧摘要失败/) : earlier
      await started.promise
      source.projects = async () => [{ cwd: '/new-project', name: '新项目', lastSelectedAt: 1 }]
      await registry.refresh('local')
      if (result === '失败') pending.reject(new Error('旧摘要失败'))
      else pending.resolve([{ cwd: '/old-project', name: '旧项目', lastSelectedAt: 0 }])
      await settled
      assert.equal(registry.list()[0].status, 'connected')
      assert.equal(registry.list()[0].error, undefined)
      assert.equal(registry.list()[0].projects[0].cwd, '/new-project')
    } finally {
      registry.close()
    }
  })
}
