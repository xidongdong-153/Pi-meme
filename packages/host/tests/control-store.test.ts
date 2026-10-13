import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { HostControlEvent, SubmissionReceipt } from '@pi-meme/contracts/app-host'
import { ControlError, ControlStore } from '../src/control-store'

async function fixture(t: import('node:test').TestContext, capacity?: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-control-store-'))
  const store = new ControlStore(root, 'host-test', capacity)
  await store.init()
  t.after(async () => {
    await store.flush()
    await rm(root, { recursive: true, force: true })
  })
  return { root, store }
}

test('同一客户端幂等键合并并发操作，冲突拒绝，不同客户端独立执行', async (t) => {
  const { store } = await fixture(t)
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const action = async () => {
    calls++
    await barrier
    return { nested: { value: calls } }
  }
  const first = store.mutate('a', 'key', 'create', [{ value: 1 }], action)
  const repeated = store.mutate('a', 'key', 'create', [{ value: 1 }], action)
  release()
  const [left, right] = await Promise.all([first, repeated])
  assert.equal(calls, 1)
  assert.deepEqual(left, right)
  left.nested.value = 999
  assert.deepEqual(await store.mutate('a', 'key', 'create', [{ value: 1 }], action), { nested: { value: 1 } })
  await assert.rejects(
    store.mutate('a', 'key', 'create', [{ value: 2 }], action),
    (error: unknown) => error instanceof ControlError && error.code === 'idempotency-conflict',
  )
  await store.mutate('b', 'key', 'create', [{ value: 1 }], action)
  assert.equal(calls, 2)
})

test('失败操作持久化失败状态，重试同一幂等键不会重复执行', async (t) => {
  const { root, store } = await fixture(t)
  let calls = 0
  const action = async () => {
    calls++
    throw new Error('确定失败')
  }
  await assert.rejects(store.mutate('a', 'failure', 'write', [], action), /确定失败/)
  const restarted = new ControlStore(root, 'host-test')
  await restarted.init()
  await assert.rejects(
    restarted.mutate('a', 'failure', 'write', [], action),
    (error: unknown) => error instanceof ControlError && error.code === 'failed',
  )
  assert.equal(calls, 1)
})

test('幂等日志只保存请求摘要，不保存终端输入正文', async (t) => {
  const { root, store } = await fixture(t)
  const text = '终端中输入的临时口令'
  await store.mutate('client', 'input', 'terminal.input', [{ terminalId: 'test' }, text], async () => undefined)
  const saved = await readFile(path.join(root, 'control.json'), 'utf8')
  assert.equal(saved.includes(text), false)
  const restarted = new ControlStore(root, 'host-test')
  await restarted.init()
  let calls = 0
  await restarted.mutate('client', 'input', 'terminal.input', [{ terminalId: 'test' }, text], async () => {
    calls++
  })
  assert.equal(calls, 0)
})

test('Host 重启将未完成提交中断，区分已开始投递和仍排队的结果不确定性', async (t) => {
  const { root, store } = await fixture(t)
  const session = {
    hostId: 'host-test',
    sessionId: 'session-test',
    cwd: root,
    createdAt: new Date().toISOString(),
    configuration: {},
    status: 'running' as const,
  }
  store.state.sessions.push(session)
  for (const dispatched of [true, false]) {
    const key = dispatched ? 'dispatched' : 'queued'
    const receipt: SubmissionReceipt = {
      operationId: key,
      submissionId: key,
      session,
      delivery: 'queue',
      status: dispatched ? 'running' : 'queued',
      ...(dispatched ? { dispatchStartedAt: new Date().toISOString() } : {}),
    }
    store.state.receipts.push(receipt)
    store.state.operations[JSON.stringify(['client', key])] = {
      operationId: key,
      input: createHash('sha256')
        .update(JSON.stringify(['submit', [key]]))
        .digest('hex'),
      status: 'pending',
    }
  }
  await store.save()
  const restarted = new ControlStore(root, 'host-test')
  await restarted.init()
  assert.equal(restarted.state.sessions[0]?.status, 'interrupted')
  assert.deepEqual(
    restarted.state.receipts.map((receipt) => [receipt.status, receipt.outcomeUncertain]),
    [
      ['interrupted', true],
      ['interrupted', false],
    ],
  )
  for (const key of ['dispatched', 'queued']) {
    let calls = 0
    const result = (await restarted.mutate('client', key, 'submit', [key], async () => {
      calls++
      return null
    })) as unknown as SubmissionReceipt
    assert.equal(result.status, 'interrupted')
    assert.equal(calls, 0)
  }
})

test('事件游标检测缺口与epoch，订阅按目标过滤，live正文不进入日志或持久化序列', async (t) => {
  const { root, store } = await fixture(t, 2)
  const epoch = store.read().cursor.journalEpoch
  await store.publish({ type: 'session', sessionId: 'a', value: { status: 'idle' } })
  await store.publish({ type: 'session', sessionId: 'b', value: { status: 'idle' } })
  await store.publish({ type: 'session', sessionId: 'a', value: { status: 'running' } })
  assert.equal(store.read({ after: { journalEpoch: epoch, seq: 0 } }).resyncRequired, true)
  assert.deepEqual(
    store.read({ sessionId: 'a', after: { journalEpoch: epoch, seq: 1 } }).events.map((event) => event.seq),
    [3],
  )
  assert.equal(store.read({ after: { journalEpoch: 'old-epoch', seq: 3 } }).resyncRequired, true)
  assert.equal(store.read({ after: { journalEpoch: epoch, seq: 99 } }).resyncRequired, true)
  const events: HostControlEvent[] = []
  const unsubscribe = store.subscribe({ sessionId: 'a', after: store.read().cursor }, (event) => events.push(event))
  const before = await readFile(path.join(root, 'control.json'), 'utf8')
  store.publishLive({ type: 'runtime', sessionId: 'a', value: { text: '仅实时传递的正文' } })
  store.publishLive({ type: 'runtime', sessionId: 'b', value: { text: '其他目标' } })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.stream, 'live')
  assert.equal(store.read().cursor.seq, 3)
  await store.flush()
  assert.equal(await readFile(path.join(root, 'control.json'), 'utf8'), before)
  assert.doesNotMatch(before, /仅实时传递的正文/)
  unsubscribe()
  store.publishLive({ type: 'runtime', sessionId: 'a', value: { text: '已取消订阅' } })
  assert.equal(events.length, 1)
  const resync: HostControlEvent[] = []
  store.subscribe({ after: { journalEpoch: 'old-epoch', seq: 0 } }, (event) => resync.push(event))()
  assert.equal(resync[0]?.type, 'resync')
})

test('临时保存失败后新操作可恢复，原失败幂等键不会自动执行或重放', async (t) => {
  const { root, store } = await fixture(t)
  const temporary = path.join(root, 'control.json.tmp')
  await mkdir(temporary)
  let failedCalls = 0
  const failedAction = async () => {
    failedCalls++
    return '不能执行'
  }
  await assert.rejects(store.mutate('client', 'failed-key', 'write', [], failedAction))
  assert.equal(failedCalls, 0)
  await rm(temporary, { recursive: true })
  let recoveredCalls = 0
  assert.equal(
    await store.mutate('client', 'new-key', 'write', [], async () => {
      recoveredCalls++
      return '已恢复'
    }),
    '已恢复',
  )
  assert.equal(recoveredCalls, 1)
  await assert.rejects(
    store.mutate('client', 'failed-key', 'write', [], failedAction),
    (error: unknown) => error instanceof ControlError && error.code === 'failed',
  )
  const restarted = new ControlStore(root, 'host-test')
  await restarted.init()
  await assert.rejects(
    restarted.mutate('client', 'failed-key', 'write', [], failedAction),
    (error: unknown) => error instanceof ControlError && error.code === 'failed',
  )
  assert.equal(failedCalls, 0)
})
