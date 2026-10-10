import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Snapshot, WorkspaceDeletionResult } from '@pi-meme/contracts/desktop'
import type { HostRpcRequest } from '@pi-meme/contracts/host'
import { HostClient } from '../src/host-client'

function snapshot(key: string, sequence = 0): Snapshot {
  return {
    connection: { sessionKey: key, generation: 1, cwd: '/project', status: 'idle' },
    state: {
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'one-at-a-time',
      followUpMode: 'all',
      pendingMessageCount: 0,
    },
    messages: [],
    models: [],
    eventSequence: sequence,
  }
}

class FakeSocket extends EventTarget {
  close() {
    this.dispatchEvent(new Event('close'))
  }
  open() {
    this.dispatchEvent(new Event('open'))
  }
  message(value: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
  }
}

function create(handle: (request: HostRpcRequest) => unknown | Promise<unknown>) {
  const requests: HostRpcRequest[] = []
  const sockets: FakeSocket[] = []
  const socketUrls: string[] = []
  const client = new HostClient({
    connection: { url: 'http://127.0.0.1:3141', token: '', hostId: 'host-1', local: false },
    clientId: 'client-1',
    selectDirectory: async () => null,
    reconnectDelay: 1,
    fetch: (async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as HostRpcRequest
      requests.push(request)
      return new Response(
        JSON.stringify({ requestId: request.requestId, hostId: 'host-1', result: await handle(request) }),
      )
    }) as typeof fetch,
    createSocket: (url) => {
      const socket = new FakeSocket()
      sockets.push(socket)
      socketUrls.push(url)
      return socket as unknown as WebSocket
    },
  })
  return { client, requests, sockets, socketUrls }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10))

for (const method of ['session:delete', 'project:remove']) {
  test(`${method} 后发布空白会话，列表和快照使用新标识`, async () => {
    const result: WorkspaceDeletionResult = {
      deletedPaths: ['/saved.jsonl'],
      deletedKeys: ['A'],
      errors: [],
      selection: { cancelled: false, snapshot: snapshot('new') },
    }
    let deleted = false
    const { client, requests } = create((request) => {
      if (request.method === method) {
        deleted = true
        return result
      }
      if (deleted && request.sessionId === 'A') throw new Error('目标会话不存在')
      if (request.method === 'pi:snapshot') return snapshot(request.sessionId ?? 'A')
      return { recents: [], projects: [], pinnedPaths: [] }
    })
    try {
      const connections: string[] = []
      client.bridge.onConnection((connection) => connections.push(connection.sessionKey!))
      await client.bridge.getConnection()
      const deletedResult =
        method === 'session:delete'
          ? await client.bridge.deleteSession('/saved.jsonl')
          : await client.bridge.removeProject('/project', ['/saved.jsonl'])
      assert.deepEqual(deletedResult, result)
      assert.deepEqual(connections, ['new'])
      assert.deepEqual((await client.bridge.getSnapshot()).messages, [])
      assert.deepEqual((await client.bridge.getSessions()).recents, [])
      assert.ok(requests.slice(-2).every((request) => request.sessionId === 'new'))
    } finally {
      client.close()
    }
  })
}

test('删除后台会话不切换，删除的迟到响应不覆盖新的会话选择', async () => {
  let finish!: (value: WorkspaceDeletionResult) => void
  const { client, requests } = create((request) => {
    if (request.method === 'pi:snapshot') return snapshot(request.sessionId ?? 'A')
    if (request.method === 'pi:switch-session') return { cancelled: false, snapshot: snapshot('B') }
    if (request.method === 'session:delete' && request.args[0] === '/background.jsonl')
      return { deletedPaths: ['/background.jsonl'], deletedKeys: ['background'], errors: [] }
    if (request.method === 'session:delete')
      return new Promise<WorkspaceDeletionResult>((resolve) => {
        finish = resolve
      })
    return []
  })
  try {
    const connections: string[] = []
    client.bridge.onConnection((connection) => connections.push(connection.sessionKey!))
    await client.bridge.getConnection()
    await client.bridge.deleteSession('/background.jsonl')
    await client.bridge.getCommands()
    assert.equal(requests.at(-1)?.sessionId, 'A')
    assert.deepEqual(connections, [])
    const deleting = client.bridge.deleteSession('/saved.jsonl')
    await tick()
    await client.bridge.switchSession('B')
    finish({
      deletedPaths: ['/saved.jsonl'],
      deletedKeys: ['A'],
      errors: [],
      selection: { cancelled: false, snapshot: snapshot('new') },
    })
    await deleting
    await client.bridge.getCommands()
    assert.equal(requests.at(-1)?.sessionId, 'B')
    assert.deepEqual(connections, ['B'])
  } finally {
    client.close()
  }
})

test('删除后台会话不取消正在进行的会话选择', async () => {
  let finish!: (value: unknown) => void
  const { client, requests } = create((request) => {
    if (request.method === 'pi:snapshot') return snapshot('A')
    if (request.method === 'pi:switch-session')
      return new Promise((resolve) => {
        finish = resolve
      })
    if (request.method === 'session:delete') return { deletedPaths: ['/background.jsonl'], deletedKeys: [], errors: [] }
    return []
  })
  try {
    await client.bridge.getConnection()
    const switching = client.bridge.switchSession('B')
    await tick()
    await client.bridge.deleteSession('/background.jsonl')
    finish({ cancelled: false, snapshot: snapshot('B') })
    await switching
    await client.bridge.getCommands()
    assert.equal(requests.at(-1)?.sessionId, 'B')
  } finally {
    client.close()
  }
})

test('指令接口经当前 Host RPC，连接展示信息不包含令牌', async () => {
  const { client, requests } = create(() => ({}))
  const input = { kind: 'agents' as const, content: '测试指令', revision: 'a'.repeat(64) }
  await client.bridge.getInstructions()
  await client.bridge.saveInstruction(input)
  assert.deepEqual(
    requests.map((request) => [request.method, request.args]),
    [
      ['settings:instructions', []],
      ['settings:save-instruction', [input]],
    ],
  )
  assert.equal(client.hostAddress, 'http://127.0.0.1:3141')
  assert.equal(client.localHost, true)
  client.close()
})

test('已有目录通过 pi:directory 选择并发布连接，显式项目选择保持 workspace:select', async () => {
  const directory = '/workspaces/standalone-id'
  const { client, requests } = create((request) => {
    if (request.method === 'pi:snapshot') return snapshot('A')
    if (request.method === 'pi:directory')
      return {
        cancelled: false,
        snapshot: {
          ...snapshot('B'),
          connection: { ...snapshot('B').connection, cwd: directory, workspaceKind: 'standalone' },
        },
      }
    return { cancelled: false, snapshot: snapshot('C') }
  })
  const connections: string[] = []
  client.bridge.onConnection((connection) => connections.push(connection.sessionKey!))
  await client.bridge.getConnection()
  assert.equal(await client.bridge.chooseDirectory(directory), directory)
  assert.deepEqual(connections, ['B'])
  await client.bridge.getCommands()
  assert.equal(requests.at(-1)?.sessionId, 'B')
  await client.bridge.selectWorkspace({ kind: 'project', cwd: '/project' })
  assert.deepEqual(connections, ['B', 'C'])
  assert.deepEqual(
    requests
      .filter((request) => ['pi:directory', 'workspace:select'].includes(request.method))
      .map((request) => [request.method, request.args]),
    [
      ['pi:directory', [directory]],
      ['workspace:select', [{ kind: 'project', cwd: '/project' }]],
    ],
  )
  client.close()
})

test('选择会话后插件管理仍请求 Host，不携带当前 sessionId', async () => {
  const { client, requests } = create((request) => (request.method === 'pi:snapshot' ? snapshot('A') : undefined))
  await client.bridge.getConnection()
  await client.plugins.list()
  await client.plugins.installDirectory('/plugin')
  await client.plugins.installPackage('package')
  await client.plugins.reload('plugin')
  await client.plugins.enable('plugin')
  await client.plugins.disable('plugin')
  await client.plugins.remove('plugin')
  const pluginRequests = requests.filter((request) => request.method.startsWith('plugins:'))
  assert.equal(pluginRequests.length, 7)
  assert.ok(pluginRequests.every((request) => !Object.hasOwn(request, 'sessionId')))
  client.close()
})

test('省略聊天图片和技能时传空数组，显式 null 参数仍保留', async () => {
  const { client, requests } = create(() => undefined)
  await client.bridge.prompt('A', '发送')
  await client.bridge.steer('A', '引导')
  await client.bridge.followUp('A', '排队')
  await client.bridge.editAndPrompt('A', 123, '编辑')
  await client.rpc('plugin:nullable', [null])
  assert.deepEqual(
    requests.map((request) => [request.method, request.args]),
    [
      ['pi:prompt', ['A', '发送', [], []]],
      ['pi:steer', ['A', '引导', [], []]],
      ['pi:follow-up', ['A', '排队', [], []]],
      ['pi:edit-and-prompt', ['A', 123, '编辑', [], []]],
      ['plugin:nullable', [null]],
    ],
  )
  client.close()
})

test('快速选择 A 和 B 时，A 的迟到响应不改变后续读取的目标', async () => {
  let finishA!: (value: unknown) => void
  const { client, requests } = create((request) => {
    if (request.method === 'pi:snapshot') return snapshot(request.sessionId ?? 'original')
    if (request.method === 'pi:switch-session' && request.args[0] === 'A')
      return new Promise((resolve) => {
        finishA = resolve
      })
    if (request.method === 'pi:switch-session') return { cancelled: false, snapshot: snapshot('B') }
    return []
  })
  await client.bridge.getConnection()
  const a = client.bridge.switchSession('A')
  await tick()
  await client.bridge.switchSession('B')
  finishA({ cancelled: false, snapshot: snapshot('A') })
  await a
  await client.bridge.getCommands()
  assert.equal(requests.at(-1)?.sessionId, 'B')
  client.close()
})

test('迟到的旧快照不改变当前客户端的会话目标', async () => {
  let finish!: (value: unknown) => void
  let calls = 0
  const { client, requests } = create((request) => {
    if (request.method === 'pi:snapshot') {
      if (++calls === 2)
        return new Promise((resolve) => {
          finish = resolve
        })
      return snapshot('A')
    }
    if (request.method === 'pi:switch-session') return { cancelled: false, snapshot: snapshot('B') }
    return []
  })
  await client.bridge.getConnection()
  const pending = client.bridge.getSnapshot()
  await tick()
  await client.bridge.switchSession('B')
  finish(snapshot('A'))
  await pending
  await client.bridge.getCommands()
  assert.equal(requests.at(-1)?.sessionId, 'B')
  client.close()
})

test('后台 A 的事件缺口读取 A 的快照，并保留当前 B 的选择', async () => {
  const { client, requests, sockets } = create((request) => {
    if (request.method === 'pi:snapshot') return snapshot(request.sessionId ?? 'B', request.sessionId === 'A' ? 10 : 0)
    return []
  })
  await client.bridge.getConnection()
  await client.connect()
  sockets[0].open()
  await tick()
  sockets[0].message({
    hostId: 'host-1',
    type: 'event',
    value: { sessionKey: 'A', generation: 1, sequence: 1, event: { type: 'agent_settled' } },
  })
  sockets[0].message({
    hostId: 'host-1',
    type: 'event',
    value: { sessionKey: 'A', generation: 1, sequence: 10, event: { type: 'agent_settled' } },
  })
  await tick()
  assert.equal(requests.filter((request) => request.method === 'pi:snapshot' && request.sessionId === 'A').length, 1)
  await client.bridge.getCommands()
  assert.equal(requests.at(-1)?.sessionId, 'B')
  client.close()
})

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

test('事件缺口快照失败后等待重连，不立即循环重放同一缺口', async () => {
  const { client, requests, sockets } = create((request) => {
    if (request.method === 'pi:snapshot' && request.sessionId === 'A') throw new Error('测试快照失败')
    return snapshot('B')
  })
  await client.bridge.getConnection()
  await client.connect()
  sockets[0].open()
  await tick()
  sockets[0].message({
    hostId: 'host-1',
    type: 'event',
    value: { sessionKey: 'A', generation: 1, sequence: 1, event: { type: 'agent_settled' } },
  })
  sockets[0].message({
    hostId: 'host-1',
    type: 'event',
    value: { sessionKey: 'A', generation: 1, sequence: 10, event: { type: 'agent_settled' } },
  })
  await tick()
  assert.equal(requests.filter((request) => request.method === 'pi:snapshot' && request.sessionId === 'A').length, 1)
  assert.equal(sockets.length, 2)
  client.close()
})

test('选择完成向连接订阅发布新目标，迟到的旧选择不发布', async () => {
  let finish!: (value: unknown) => void
  const { client } = create((request) => {
    if (request.method === 'pi:snapshot') return snapshot('original')
    if (request.args[0] === 'A')
      return new Promise((resolve) => {
        finish = resolve
      })
    return { cancelled: false, snapshot: snapshot('B') }
  })
  const connections: string[] = []
  client.bridge.onConnection((connection) => {
    connections.push(connection.sessionKey!)
  })
  await client.bridge.getConnection()
  const a = client.bridge.switchSession('A')
  await tick()
  await client.bridge.switchSession('B')
  assert.deepEqual(connections, ['B'])
  finish({ cancelled: false, snapshot: snapshot('A') })
  await a
  assert.deepEqual(connections, ['B'])
  client.close()
})
