import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { Snapshot, WorkspaceDeletionResult } from '@pi-meme/contracts/desktop'
import { snapshot, create, tick } from './host-client-fixture'

test('选择项目源目录不登记项目，也不切换当前会话', async () => {
  const { client, requests } = create(() => null, { selectDirectory: async () => '/work/new-project' })
  try {
    assert.equal(await client.bridge.pickProjectDirectory(), '/work/new-project')
    assert.deepEqual(requests, [])
  } finally {
    client.close()
  }
})

test('历史正文搜索发送显式路径，不绑定当前选择，也不发布会话切换', async () => {
  const matches = [{ path: '/saved.jsonl', excerpt: '正文命中' }]
  const { client, requests } = create(() => matches)
  const connections: string[] = []
  client.bridge.onConnection((connection) => connections.push(connection.sessionKey!))
  try {
    assert.deepEqual(await client.bridge.searchSessions('正文', ['/saved.jsonl']), matches)
    assert.equal(requests[0].method, 'session:search')
    assert.deepEqual(requests[0].args, ['正文', ['/saved.jsonl']])
    assert.equal(requests[0].sessionId, undefined)
    assert.deepEqual(connections, [])
  } finally {
    client.close()
  }
})

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

test('选择失败后，进行中发起的快照与后续读取仍使用原会话', async () => {
  let rejectSelection!: (cause: Error) => void
  let finishRead!: (value: Snapshot) => void
  let selectionStarted!: () => void
  let readStarted!: () => void
  const selectingRequest = new Promise<void>((resolve) => {
    selectionStarted = resolve
  })
  const readingRequest = new Promise<void>((resolve) => {
    readStarted = resolve
  })
  let reads = 0
  const { client, requests } = create((request) => {
    if (request.method === 'workspace:select')
      return new Promise((_, reject) => {
        rejectSelection = reject
        selectionStarted()
      })
    if (request.method === 'pi:snapshot') {
      if (++reads === 2)
        return new Promise<Snapshot>((resolve) => {
          finishRead = resolve
          readStarted()
        })
      return snapshot(request.sessionId ?? 'A')
    }
    return []
  })
  try {
    await client.bridge.getConnection()
    const selecting = client.bridge.selectWorkspace({ kind: 'project', cwd: '/unavailable' })
    const rejected = assert.rejects(selecting, /目录不可用/)
    await selectingRequest
    const reading = client.bridge.getSnapshot()
    await readingRequest
    rejectSelection(new Error('目录不可用'))
    await rejected
    finishRead(snapshot('A'))
    assert.equal((await reading).connection.sessionKey, 'A')
    assert.equal((await client.bridge.getConnection()).sessionKey, 'A')
    await client.bridge.getProjectFiles('/project', 'src')
    assert.equal(requests.at(-1)?.sessionId, 'A')
  } finally {
    client.close()
  }
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

test('读取子代理快照与缺口恢复不改变主客户端selection，发送mode传到指定根会话', async () => {
  let childReads = 0
  const { client, requests, sockets } = create((request) => {
    if (request.method === 'pi:agent-snapshot') {
      childReads++
      return snapshot('child-session', childReads === 1 ? 1 : 4)
    }
    if (request.method === 'pi:snapshot') return snapshot(request.sessionId ?? 'main')
    if (request.method === 'pi:agents') return []
    return undefined
  })
  try {
    await client.connect()
    await client.bridge.getConnection()
    await client.bridge.getAgentSnapshot('child')
    sockets[0].message({
      hostId: 'host-1',
      type: 'event',
      value: {
        generation: 1,
        sessionKey: 'child-session',
        agentId: 'child',
        sequence: 4,
        event: { type: 'agent_start' },
      },
    })
    await tick()
    await client.bridge.prompt('main', '后续任务', [], [], { mode: 'plan' })
    await client.bridge.getSessions()
    assert.equal(childReads, 2)
    const request = requests.find((entry) => entry.method === 'pi:prompt')!
    assert.equal(request.sessionId, 'main')
    assert.deepEqual(request.args[4], { mode: 'plan' })
    assert.equal(requests.at(-1)?.sessionId, 'main')
    assert.ok(
      requests.filter((entry) => entry.method === 'pi:agent-snapshot').every((entry) => entry.sessionId === undefined),
    )
  } finally {
    client.close()
  }
})

test('从未查看的子代理事件缺口只恢复agent快照，不调用根Pool快照或断开主连接', async () => {
  const { client, requests, sockets } = create((request) => {
    if (request.method === 'pi:agent-snapshot') return snapshot('unopened-child', 5)
    if (request.method === 'pi:snapshot') {
      assert.notEqual(request.sessionId, 'unopened-child')
      return snapshot(request.sessionId ?? 'main')
    }
    return undefined
  })
  try {
    await client.connect()
    await client.bridge.getConnection()
    const connections: string[] = []
    client.bridge.onConnection((connection) => connections.push(connection.status))
    sockets[0].message({
      hostId: 'host-1',
      type: 'event',
      value: {
        generation: 1,
        sessionKey: 'unopened-child',
        agentId: 'unopened-id',
        rootAgentId: 'root-id',
        executionGeneration: 1,
        sequence: 5,
        event: { type: 'agent_start' },
      },
    })
    await tick()
    assert.equal(requests.filter((request) => request.method === 'pi:agent-snapshot').length, 1)
    assert.ok(!connections.includes('disconnected'))
    await client.bridge.getSessions()
    assert.equal(requests.at(-1)?.sessionId, 'main')
  } finally {
    client.close()
  }
})

test('首次快照只释放本客户端遗留编辑，其他客户端占位不变，后续快照与WS重连不释放新编辑', async () => {
  let ownEditing = true
  let otherEditing = true
  const f = create((request) => {
    if (request.method === 'pi:cancel-queue-edit') {
      if (request.args[1] === 'other') throw new Error('此客户端未持有排队输入编辑权')
      ownEditing = false
      return undefined
    }
    if (request.method === 'pi:begin-queue-edit') {
      ownEditing = true
      return { id: 'own', text: '原始输入', mode: 'default', editing: true }
    }
    if (request.method === 'pi:snapshot')
      return {
        ...snapshot('A'),
        events: [
          {
            generation: 1,
            event: {
              type: 'queue_update',
              steering: [],
              followUp: [
                { id: 'own', text: '原始输入', mode: 'default', editing: ownEditing },
                { id: 'other', text: '其他客户端', mode: 'default', editing: otherEditing },
              ],
            },
          },
        ],
      }
    return []
  })
  try {
    await f.client.bridge.getConnection()
    assert.equal(ownEditing, false)
    assert.equal(otherEditing, true)
    assert.equal(f.requests.filter((request) => request.method === 'pi:cancel-queue-edit').length, 2)
    await f.client.bridge.beginQueueEdit('A', 'own')
    await f.client.bridge.getSnapshot()
    await f.client.bridge.getConnection()
    await f.client.connect()
    f.sockets[0]!.open()
    await tick()
    f.sockets[0]!.close()
    await tick()
    f.sockets[1]!.open()
    await tick()
    assert.equal(ownEditing, true)
    assert.equal(otherEditing, true)
    assert.equal(f.requests.filter((request) => request.method === 'pi:cancel-queue-edit').length, 2)
  } finally {
    f.client.close()
    otherEditing = false
  }
})

test('首次恢复编辑遇到网络错误时保留占位，后续快照重试后只成功释放一次', async () => {
  let editing = true
  let attempts = 0
  const f = create((request) => {
    if (request.method === 'pi:cancel-queue-edit') {
      attempts += 1
      if (attempts === 1) throw new Error('连接暂时中断')
      editing = false
      return undefined
    }
    if (request.method === 'pi:snapshot')
      return {
        ...snapshot('A'),
        events: [
          {
            generation: 1,
            event: {
              type: 'queue_update',
              steering: [],
              followUp: [{ id: 'own', text: '保留原输入', mode: 'default', editing }],
            },
          },
        ],
      }
    return []
  })
  try {
    await assert.rejects(f.client.bridge.getConnection(), /连接暂时中断/)
    assert.equal(editing, true)
    const restored = await f.client.bridge.getSnapshot()
    assert.equal(editing, false)
    const queue = restored.events?.find((value) => value.event.type === 'queue_update')?.event
    assert.ok(queue?.type === 'queue_update')
    assert.equal(queue.followUp[0]?.editing, false)
    await f.client.bridge.getConnection()
    assert.equal(attempts, 2)
  } finally {
    f.client.close()
  }
})
