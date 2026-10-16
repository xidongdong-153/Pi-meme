import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { Snapshot, WorkspaceDeletionResult } from '@pi-meme/contracts/desktop'
import type { HostRpcRequest } from '@pi-meme/contracts/host'
import { HostClient, type ClientOptions } from '../src/host-client'

function snapshot(key: string, sequence = 0): Snapshot {
  return {
    connection: { sessionKey: key, generation: 1, cwd: '/project', status: 'idle' },
    state: {
      mode: 'default',
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

function create(handle: (request: HostRpcRequest) => unknown | Promise<unknown>, options: Partial<ClientOptions> = {}) {
  const requests: HostRpcRequest[] = []
  const sockets: FakeSocket[] = []
  const socketUrls: string[] = []
  const client = new HostClient({
    connection: { url: 'http://127.0.0.1:3141', token: '', hostId: 'host-1', local: false },
    clientId: 'client-1',
    selectDirectory: async () => null,
    reconnectDelay: 1,
    fetch: (async (_url, init) => {
      if (new URL(String(_url)).pathname === '/api/auth') return new Response(JSON.stringify({ hostId: 'host-1' }))
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
    ...options,
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

for (const read of ['getConnection', 'getSnapshot'] as const) {
  test(`选择进行中发起的 ${read} 迟到后，不退回旧会话或改变文件补全目标`, async () => {
    let finishSelection!: (value: unknown) => void
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
      if (request.method === 'workspace:select' || request.method === 'pi:directory')
        return new Promise((resolve) => {
          finishSelection = resolve
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
      const connections: string[] = []
      client.bridge.onConnection((connection) => connections.push(connection.sessionKey!))
      await client.bridge.getConnection()
      const selecting =
        read === 'getConnection'
          ? client.bridge.selectWorkspace({ kind: 'project', cwd: '/new-project' })
          : client.bridge.chooseDirectory('/new-project')
      await selectingRequest
      const reading = client.bridge[read]()
      await readingRequest
      assert.equal(requests.at(-1)?.sessionId, 'A')
      finishSelection({ cancelled: false, snapshot: snapshot('B') })
      await selecting
      finishRead(snapshot('A'))
      await reading
      const connection = await client.bridge.getConnection()
      assert.deepEqual(connections, ['B'])
      assert.equal(connection.sessionKey, 'B')
      await client.bridge.getProjectFiles('/new-project', 'src')
      assert.equal(requests.at(-1)?.sessionId, 'B')
      await client.bridge.prompt(connection.sessionKey!, '后续任务')
      assert.equal(requests.at(-1)?.sessionId, connections.at(-1))
    } finally {
      client.close()
    }
  })
}

async function withBrowserStorage(run: (values: Map<string, string>) => void | Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value)
        },
      },
    },
  })
  try {
    await run(values)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

export { create, FakeSocket, snapshot, tick, withBrowserStorage }
