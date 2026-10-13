import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import type { EventCursor, HostControlEvent } from '@pi-meme/contracts/app-host'
import { createNodeHostClient } from '@pi-meme/client/node-host-client'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { startHostServer } from '../src/server'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

async function eventually(check: () => boolean) {
  const deadline = Date.now() + 12000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Node 客户端集成测试等待超时')
    await delay(10)
  }
}
async function fixture(reply?: NonNullable<Parameters<typeof useFakeAgent>[1]>['reply']) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-node-host-client-')))
  const fake = reply === undefined ? undefined : await useFakeAgent(root, { reply })
  let server = await startHostServer({
    dataRoot: fake?.runtimePaths.dataRoot ?? path.join(root, 'data'),
    token: 'test-token',
    credentials: fake?.credentials ?? new MemoryCredentialStorage(),
  })
  const sockets: WebSocket[] = []
  const urls: string[] = []
  const clients: Array<{ dispose: () => void }> = []
  const webSocket = (url: string, headers: Record<string, string>) => {
    const socket = new WebSocket(url, { headers })
    sockets.push(socket)
    urls.push(url)
    return socket
  }
  const connect = async (options: { token?: string; hostId?: string; clientId?: string } = {}) => {
    const client = await createNodeHostClient({
      url: server.url,
      token: options.token ?? 'test-token',
      hostId: options.hostId,
      clientId: options.clientId ?? 'node-test',
      webSocket,
    })
    clients.push(client)
    return client
  }
  return {
    root,
    fake,
    sockets,
    urls,
    connect,
    get server() {
      return server
    },
    async replaceHost() {
      const port = Number(new URL(server.url).port)
      await server.dispose()
      server = await startHostServer({
        dataRoot: path.join(root, 'replacement'),
        port,
        token: 'test-token',
        credentials: new MemoryCredentialStorage(),
      })
    },
    async dispose() {
      for (const client of clients) client.dispose()
      for (const socket of sockets) socket.terminate()
      await server.dispose()
      await fake?.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
const key = (idempotencyKey: string) => ({ idempotencyKey })

test('Node客户端真实鉴权与正式域调用，稳定refs和写操作幂等键经过HTTP校验', { timeout: 25000 }, async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.connect({ token: 'wrong-token' }), /Host 登录失败/)
    await assert.rejects(f.connect({ hostId: 'wrong-host' }), /Host 身份已变化/)
    const client = await f.connect({ hostId: f.server.host.hostId })
    const capabilities = await client.capabilities()
    assert.equal(capabilities.apiVersion, 2)
    assert.equal(capabilities.hostId, f.server.host.hostId)
    assert.ok(capabilities.features.includes('projects'))
    const cwd = path.join(f.root, 'project')
    await mkdir(cwd)
    await writeFile(path.join(cwd, 'readme.txt'), 'Node客户端读取的正文')
    const input = { cwd, name: 'Node项目' }
    const [left, right] = await Promise.all([
      client.projects.register(input, key('project')),
      client.projects.register(input, key('project')),
    ])
    assert.equal(left.projectId, right.projectId)
    assert.equal((await client.projects.list()).filter((project) => project.projectId === left.projectId).length, 1)
    const project = { hostId: left.hostId, projectId: left.projectId }
    assert.equal((await client.projects.get(project)).cwd, cwd)
    assert.ok((await client.files.list(project)).some((entry) => entry.relativePath === 'readme.txt'))
    assert.equal((await client.files.read(project, 'readme.txt')).content, 'Node客户端读取的正文')
    const session = await client.sessions.create({ project, name: '空会话' }, key('session'))
    const ref = { hostId: session.hostId, sessionId: session.sessionId }
    assert.equal((await client.sessions.get(ref)).sessionId, session.sessionId)
    assert.equal((await client.sessions.snapshot(ref)).messages.length, 0)
    const repeated = await client.sessions.create({ project, name: '空会话' }, key('session'))
    assert.equal(repeated.sessionId, session.sessionId)
    await assert.rejects(
      client.sessions.create({ project, name: '不同内容' }, key('session')),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'idempotency-conflict',
    )
    await assert.rejects(
      client.projects.register(input, key('')),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid-key',
    )
    const other = await f.connect({ clientId: 'another-node' })
    const independent = await other.sessions.create({ project, name: '空会话' }, key('session'))
    assert.notEqual(independent.sessionId, session.sessionId)
    client.dispose()
    await assert.rejects(client.capabilities(), /客户端已关闭/)
  } finally {
    await f.dispose()
  }
})

test('Node客户端WebSocket断连后携带最新cursor补读缺口，不重复投递旧事件', { timeout: 25000 }, async () => {
  const f = await fixture()
  try {
    const client = await f.connect()
    const cwd = path.join(f.root, 'project')
    await mkdir(cwd)
    const project = await client.projects.register({ cwd }, key('project'))
    const initial = await client.events.read()
    const events: HostControlEvent[] = []
    const unsubscribe = await client.events.subscribe(
      { projectId: project.projectId, after: initial.cursor },
      (event) => events.push(event),
    )
    await eventually(() => f.sockets[0]?.readyState === WebSocket.OPEN)
    const first = await client.sessions.create({ project }, key('first'))
    await eventually(() => events.some((event) => event.type === 'session' && event.sessionId === first.sessionId))
    const durable = events.filter((event) => event.stream !== 'live').at(-1)!
    const cursor: EventCursor = { journalEpoch: durable.journalEpoch, seq: durable.seq }
    f.sockets[0]!.terminate()
    await eventually(() => f.sockets[0]?.readyState === WebSocket.CLOSED)
    const second = await client.sessions.create({ project }, key('second'))
    await eventually(
      () =>
        f.sockets.length >= 2 &&
        events.some((event) => event.type === 'session' && event.sessionId === second.sessionId),
    )
    const subscription = JSON.parse(new URL(f.urls[1]!).searchParams.get('subscription')!) as {
      after: EventCursor
      projectId: string
    }
    assert.deepEqual(subscription.after, cursor)
    assert.equal(subscription.projectId, project.projectId)
    assert.equal(events.filter((event) => event.type === 'session' && event.sessionId === first.sessionId).length, 1)
    assert.equal(events.filter((event) => event.type === 'session' && event.sessionId === second.sessionId).length, 1)
    assert.ok(events.every((event) => event.hostId === f.server.host.hostId))
    unsubscribe()
    const count = events.length
    await client.sessions.create({ project }, key('after-unsubscribe'))
    await delay(40)
    assert.equal(events.length, count)
    assert.equal(f.sockets.length, 2)
  } finally {
    await f.dispose()
  }
})

test('同一URL替换为另一Host后，Node客户端拒绝重新认证后的身份变化', { timeout: 25000 }, async () => {
  const f = await fixture()
  try {
    const client = await f.connect({ hostId: f.server.host.hostId })
    const originalId = (await client.capabilities()).hostId
    await f.replaceHost()
    assert.notEqual(f.server.host.hostId, originalId)
    await assert.rejects(client.capabilities(), /Host 身份已变化/)
  } finally {
    await f.dispose()
  }
})

test('Node客户端提交输入携带幂等键，并发重复只产生一条提交和一次模型请求', { timeout: 25000 }, async () => {
  const f = await fixture('Node输入的假模型回复')
  try {
    const client = await f.connect()
    const cwd = path.join(f.root, 'project')
    await mkdir(cwd)
    const registered = await client.projects.register({ cwd }, key('project'))
    const project = { hostId: registered.hostId, projectId: registered.projectId }
    const created = await client.sessions.create(
      { project, configuration: { model: { provider: 'fake', id: 'first' }, accessMode: 'full-access' } },
      key('session'),
    )
    const ref = { hostId: created.hostId, sessionId: created.sessionId }
    const input = { delivery: 'start' as const, text: '通过Node客户端提交的输入' }
    const [first, repeated] = await Promise.all([
      client.sessions.submit(ref, input, key('input')),
      client.sessions.submit(ref, input, key('input')),
    ])
    assert.equal(first.operationId, repeated.operationId)
    assert.equal(first.submissionId, repeated.submissionId)
    const deadline = Date.now() + 10000
    let receipt = await client.sessions.receipt(first.operationId)
    while (!['completed', 'failed', 'interrupted'].includes(receipt.status)) {
      if (Date.now() > deadline) throw new Error('Node输入回执等待超时')
      await delay(10)
      receipt = await client.sessions.receipt(first.operationId)
    }
    assert.equal(receipt.status, 'completed')
    assert.equal(f.fake?.provider.requests.length, 1)
    assert.equal((await client.sessions.submissions(ref)).length, 1)
    assert.match(JSON.stringify((await client.sessions.history(ref)).messages), /通过Node客户端提交的输入/)
    await assert.rejects(
      client.sessions.submit(ref, { ...input, text: '重复键的不同输入' }, key('input')),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'idempotency-conflict',
    )
  } finally {
    await f.dispose()
  }
})
