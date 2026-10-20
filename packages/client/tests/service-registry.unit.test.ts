import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { HostRpcRequest } from '@pi-meme/contracts/host'
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
