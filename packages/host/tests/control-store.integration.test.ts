import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test, vi } from 'vitest'
import type { HostControlEvent, SubmissionReceipt } from '@pi-meme/contracts/app-host'
import { createAppControl } from '../src/app-control'
import { ControlError, ControlStore, createControlStorePaths } from '../src/control-store'

async function fixture(t: import('vitest').TestContext, capacity?: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-control-store-'))
  const paths = createControlStorePaths(path.join(root, 'state/control'))
  const store = new ControlStore(paths, 'host-test', capacity)
  await store.init()
  t.onTestFinished(async () => {
    vi.restoreAllMocks()
    await store.flush()
    await rm(root, { recursive: true, force: true })
  })
  return { root, paths, store }
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

for (const completed of [false, true]) {
  test(`目标提交幂等回放保留目标和最新回执，重启${completed ? '保留完成状态' : '中断未完成执行'}`, async (t) => {
    const { paths, store } = await fixture(t)
    const goal = { goalId: 'goal-test', objective: '保留目标提交结果' }
    let calls = 0
    const action = async (operationId: string) => {
      calls++
      const receipt: SubmissionReceipt = {
        operationId,
        submissionId: 'submission-test',
        session: { hostId: 'host-test', sessionId: 'session-test' },
        delivery: 'start',
        status: 'accepted',
      }
      await store.publish({ type: 'submission', sessionId: receipt.session.sessionId, value: receipt })
      return { goal, receipt }
    }
    const first = await store.mutate('client', 'goal', 'goals.start', [], action)
    const latest = { ...first.receipt, status: completed ? ('completed' as const) : ('running' as const) }
    await store.publish({ type: 'submission', sessionId: latest.session.sessionId, value: latest })
    assert.deepEqual(await store.mutate('client', 'goal', 'goals.start', [], action), { goal, receipt: latest })
    await store.flush()
    const restarted = new ControlStore(paths, 'host-test')
    await restarted.init()
    const replay = await restarted.mutate('client', 'goal', 'goals.start', [], action)
    assert.deepEqual(replay.goal, goal)
    assert.equal(replay.receipt.operationId, first.receipt.operationId)
    assert.equal(replay.receipt.status, completed ? 'completed' : 'interrupted')
    assert.deepEqual(replay.receipt, restarted.state.receipts[0])
    assert.equal(calls, 1)
  })
}

test('失败操作持久化失败状态，重试同一幂等键不会重复执行', async (t) => {
  const { paths, store } = await fixture(t)
  let calls = 0
  const action = async () => {
    calls++
    throw new Error('确定失败')
  }
  await assert.rejects(store.mutate('a', 'failure', 'write', [], action), /确定失败/)
  const restarted = new ControlStore(paths, 'host-test')
  await restarted.init()
  await assert.rejects(
    restarted.mutate('a', 'failure', 'write', [], action),
    (error: unknown) => error instanceof ControlError && error.code === 'failed',
  )
  assert.equal(calls, 1)
})

test('幂等日志只保存请求摘要，不保存终端输入正文', async (t) => {
  const { paths, store } = await fixture(t)
  const text = '终端中输入的临时口令'
  await store.mutate('client', 'input', 'terminal.input', [{ terminalId: 'test' }, text], async () => undefined)
  const saved = await readFile(store.paths.controlOperationsFile, 'utf8')
  assert.equal(saved.includes(text), false)
  const restarted = new ControlStore(paths, 'host-test')
  await restarted.init()
  let calls = 0
  await restarted.mutate('client', 'input', 'terminal.input', [{ terminalId: 'test' }, text], async () => {
    calls++
  })
  assert.equal(calls, 0)
})

test('Host 重启将未完成提交中断，区分已开始投递和仍排队的结果不确定性', async (t) => {
  const { paths, store, root } = await fixture(t)
  const session = {
    hostId: 'host-test',
    sessionId: 'session-test',
    cwd: root,
    createdAt: new Date().toISOString(),
    configuration: {},
    status: 'running' as const,
  }
  await store.saveSession(session)
  for (const dispatched of [true, false]) {
    const opKey = dispatched ? 'dispatched' : 'queued'
    const receipt: SubmissionReceipt = {
      operationId: opKey,
      submissionId: opKey,
      session,
      delivery: 'queue',
      status: dispatched ? 'running' : 'queued',
      ...(dispatched ? { dispatchStartedAt: new Date().toISOString() } : {}),
    }
    const id = JSON.stringify(['client', opKey])
    const input = createHash('sha256')
      .update(JSON.stringify(['submit', [opKey]]))
      .digest('hex')
    store.state.receipts.push(receipt)
    store.state.operations[id] = {
      operationId: opKey,
      input,
      status: 'pending',
    }
    await store.publish({ type: 'submission', sessionId: session.sessionId, value: receipt })
  }
  await store.save()
  const restarted = new ControlStore(paths, 'host-test')
  await restarted.init()
  assert.equal(restarted.state.sessions[0]?.status, 'interrupted')
  assert.deepEqual(
    restarted.state.receipts.map((receipt) => [receipt.status, receipt.outcomeUncertain]),
    [
      ['interrupted', true],
      ['interrupted', false],
    ],
  )
  for (const opKey of ['dispatched', 'queued']) {
    let calls = 0
    const result = (await restarted.mutate('client', opKey, 'submit', [opKey], async () => {
      calls++
      return null
    })) as unknown as SubmissionReceipt
    assert.equal(result.status, 'interrupted')
    assert.equal(calls, 0)
  }
})

test('事件游标检测缺口与epoch，订阅按目标过滤，live正文不进入日志或持久化序列', async (t) => {
  const { store } = await fixture(t, 2)
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
  const before = await readFile(store.paths.controlEventsFile, 'utf8')
  store.publishLive({ type: 'runtime', sessionId: 'a', value: { text: '仅实时传递的正文' } })
  store.publishLive({ type: 'runtime', sessionId: 'b', value: { text: '其他目标' } })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.stream, 'live')
  assert.equal(store.read().cursor.seq, 3)
  await store.flush()
  const after = await readFile(store.paths.controlEventsFile, 'utf8')
  assert.equal(after, before)
  assert.doesNotMatch(after, /仅实时传递的正文/)
  unsubscribe()
  store.publishLive({ type: 'runtime', sessionId: 'a', value: { text: '已取消订阅' } })
  assert.equal(events.length, 1)
  const resync: HostControlEvent[] = []
  store.subscribe({ after: { journalEpoch: 'old-epoch', seq: 0 } }, (event) => resync.push(event))()
  assert.equal(resync[0]?.type, 'resync')
})

test('故障注入 1: append 失败后 Store 进入锁定状态，拒绝后续追加以防损坏尾部变坏中段', async (t) => {
  const { store } = await fixture(t)
  await store.publish({ type: 'session', sessionId: 's1', value: { status: 'idle' } })

  await rm(store.paths.controlEventsFile)
  await mkdir(store.paths.controlEventsFile)

  try {
    await assert.rejects(store.publish({ type: 'session', sessionId: 's1', value: { status: 'running' } }), /EISDIR/)

    await rm(store.paths.controlEventsFile, { recursive: true })
    await assert.rejects(
      store.publish({ type: 'session', sessionId: 's1', value: { status: 'running' } }),
      (error: unknown) => error instanceof ControlError && error.code === 'store-poisoned',
    )
  } finally {
    await rm(store.paths.controlEventsFile, { recursive: true, force: true })
  }
})

test('故障注入 2: 操作 pending 落盘失败或不确定绝不执行 action', async (t) => {
  const { store } = await fixture(t)
  await rm(store.paths.controlOperationsFile).catch(() => {})
  await mkdir(store.paths.controlOperationsFile)

  let actionRan = false
  try {
    await assert.rejects(
      store.mutate('client', 'op-fail', 'action', [], async () => {
        actionRan = true
        return 'ok'
      }),
      /EISDIR/,
    )
    assert.equal(actionRan, false, 'pending 操作未安全落盘前绝不能执行 action')
  } finally {
    await rm(store.paths.controlOperationsFile, { recursive: true, force: true })
  }
})

test('故障注入 3: 事件日志中段损坏严格报错，尾部未完成截断容错恢复并支持追加重启', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-control-corrupt-'))
  try {
    const paths = createControlStorePaths(path.join(root, 'state/control'))
    await mkdir(paths.controlDirectory, { recursive: true })

    await writeFile(
      paths.controlEventsFile,
      `${JSON.stringify({ commitSeq: 1, journalEpoch: 'e1', timestamp: new Date().toISOString() })}\n{"commitSeq":2,"journalE`,
      'utf8',
    )
    const store = new ControlStore(paths, 'host-test')
    store.state.journalEpoch = 'e1'
    await store.init()
    assert.equal(store.state.commitSeq, 1, '尾部截断不完整行被安全容错忽略并截断')

    await store.publish({ type: 'session', sessionId: 's_after_trunc', value: { status: 'idle' } })

    const store2 = new ControlStore(paths, 'host-test')
    await store2.init()
    assert.equal(store2.state.commitSeq, 2)
    assert.equal(store2.state.events.length, 1)

    // 测试中段损坏（完整行字段错误或 JSON 损坏）
    const corruptedDir = path.join(root, 'corrupted')
    const badPaths = createControlStorePaths(path.join(corruptedDir, 'state/control'))
    await mkdir(badPaths.controlDirectory, { recursive: true })
    const badStore = new ControlStore(badPaths, 'host-test')
    const epoch = badStore.state.journalEpoch
    await writeFile(
      badPaths.controlEventsFile,
      `${JSON.stringify({ commitSeq: 1, journalEpoch: epoch, timestamp: new Date().toISOString() })}\n{CORRUPTED_JSON}\n${JSON.stringify({ commitSeq: 3, journalEpoch: epoch, timestamp: new Date().toISOString() })}\n`,
      'utf8',
    )
    await assert.rejects(badStore.init(), /事件日志数据损坏/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('未知快照版本或结构损坏严格拒绝启动，日志 epoch 不匹配拒绝回放', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-control-bad-snap-'))
  try {
    const paths = createControlStorePaths(path.join(root, 'state/control'))
    await mkdir(paths.controlDirectory, { recursive: true })

    // 写入未知版本的 snapshot
    await writeFile(
      paths.controlSnapshotFile,
      JSON.stringify({ version: 999, journalEpoch: 'e1', appliedCommitSeq: 0, seq: 0 }),
      'utf8',
    )
    const storeBadVersion = new ControlStore(paths, 'host-test')
    await assert.rejects(storeBadVersion.init(), /控制快照格式无效或版本不匹配/)

    // 写入合法 snapshot 但 events 中 epoch 冲突
    await writeFile(
      paths.controlSnapshotFile,
      JSON.stringify({
        version: 2,
        journalEpoch: 'correct-epoch',
        appliedCommitSeq: 0,
        seq: 0,
        projects: [],
        sessions: [],
        receipts: [],
      }),
      'utf8',
    )
    await writeFile(
      paths.controlEventsFile,
      `${JSON.stringify({ commitSeq: 1, journalEpoch: 'different-epoch', timestamp: new Date().toISOString() })}\n`,
      'utf8',
    )
    const storeBadEpoch = new ControlStore(paths, 'host-test')
    await assert.rejects(storeBadEpoch.init(), /控制日志 epoch 不匹配/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('写放大量与性能验收：连续发布多个事件只增量追加单行，不重写全量快照', async (_t) => {
  const { paths, store } = await fixture(_t)

  for (let i = 0; i < 5; i++) {
    await store.saveProject({ hostId: 'host-test', projectId: `p-${i}`, cwd: `/cwd-${i}`, name: `Proj-${i}` })
    await store.saveSession({
      hostId: 'host-test',
      sessionId: `s-${i}`,
      cwd: `/cwd-${i}`,
      createdAt: new Date().toISOString(),
      configuration: {},
      status: 'idle',
    })
  }
  await store.checkpoint()
  const snapStatBefore = await stat(paths.controlSnapshotFile)
  const snapSizeBefore = snapStatBefore.size
  assert.ok(snapSizeBefore > 100)

  for (let i = 0; i < 20; i++) {
    await store.publish({ type: 'session', sessionId: 's-0', value: { status: 'running' } })
  }

  const snapStatAfter = await stat(paths.controlSnapshotFile)
  assert.equal(snapStatAfter.mtimeMs, snapStatBefore.mtimeMs, '快照文件未被频繁重写')

  const eventsContent = await readFile(paths.controlEventsFile, 'utf8')
  const lines = eventsContent.trim().split('\n')
  assert.equal(lines.length, 20 + 10)
})

test('并发 publish 与 checkpoint 交叠：快照高水位绝不超前于实际 journal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-interleave-test-'))
  try {
    const paths = createControlStorePaths(path.join(root, 'state/control'))
    const store = new ControlStore(paths, 'host-test', 10)
    await store.init()

    // 并发提交多个 publish 和 checkpoint，验证队列保证高水位永远一致
    const jobs: Promise<unknown>[] = []
    for (let i = 1; i <= 30; i++) {
      jobs.push(store.publish({ type: 'session', sessionId: 's1', value: { step: i } }))
      if (i % 5 === 0) {
        jobs.push(store.checkpoint())
      }
    }
    await Promise.all(jobs)
    await store.flush()

    // 检验 snapshot.json
    const snapContent = await readFile(paths.controlSnapshotFile, 'utf8')
    const snap = JSON.parse(snapContent)

    // 检验 events.jsonl
    const eventsContent = await readFile(paths.controlEventsFile, 'utf8')
    const lines = eventsContent.trim().split('\n')
    const lastLine = JSON.parse(lines[lines.length - 1]!)

    assert.ok(snap.appliedCommitSeq <= lastLine.commitSeq, 'snapshot appliedCommitSeq 绝不超前实际 journal')
    assert.ok(snap.seq <= lastLine.event.seq, 'snapshot seq 绝不超前实际 journal')
    assert.equal(lastLine.commitSeq, 30)
    assert.equal(lastLine.event.seq, 30)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('未提交的外部对象修改绝不泄漏至快照：checkpoint 仅捕获私有已提交实体视图', async (_t) => {
  const { paths, store } = await fixture(_t)

  const session = {
    hostId: 'host-test',
    sessionId: 's-committed',
    cwd: '/test/cwd',
    createdAt: new Date().toISOString(),
    name: 'committed_name',
    configuration: {},
    status: 'idle' as const,
  }
  await store.saveSession(session)
  await store.checkpoint()

  // 外部直接获取 store.state.sessions 中的对象并修改，但尚未调用 saveSession
  const liveSession = store.state.sessions.find((s) => s.sessionId === 's-committed')!
  liveSession.name = 'dirty_uncommitted_name'

  // 此时另一并发操作触发 checkpoint
  await store.checkpoint()

  // 读取磁盘上的 snapshot.json，验证写入的必须是已提交的 committed_name，绝不能是 dirty_uncommitted_name！
  const snapContent = await readFile(paths.controlSnapshotFile, 'utf8')
  const snap = JSON.parse(snapContent)
  const snapSession = snap.sessions.find((s: any) => s.sessionId === 's-committed')
  assert.equal(snapSession.name, 'committed_name', '未提交的外部修改绝不泄漏入磁盘快照')

  // 当外部显式调用 saveSession 提交变更后，checkpoint 才会写入新值
  await store.saveSession(liveSession)
  await store.checkpoint()
  const snapContentAfter = await readFile(paths.controlSnapshotFile, 'utf8')
  const snapAfter = JSON.parse(snapContentAfter)
  const snapSessionAfter = snapAfter.sessions.find((s: any) => s.sessionId === 's-committed')
  assert.equal(snapSessionAfter.name, 'dirty_uncommitted_name', '显式提交后快照才更新')
})

test('纯 mutation 压缩安全：丢弃已覆盖入快照的前缀，实测日志行数精确收敛', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-mutation-compact-'))
  try {
    const paths = createControlStorePaths(path.join(root, 'state/control'))
    const store = new ControlStore(paths, 'host-test', 5)
    await store.init()

    for (let i = 1; i <= 15; i++) {
      await store.saveSession({
        hostId: 'host-test',
        sessionId: 's1',
        cwd: root,
        createdAt: new Date().toISOString(),
        name: `name_${i}`,
        configuration: {},
        status: 'idle',
      })
    }

    await store.save()

    const eventsContent = await readFile(paths.controlEventsFile, 'utf8')
    const remainingLines = eventsContent.trim() ? eventsContent.trim().split('\n') : []
    assert.equal(remainingLines.length, 0, '纯 mutation 日志经压缩后前缀全部安全丢弃，行数为 0')

    const snapContent = await readFile(paths.controlSnapshotFile, 'utf8')
    const snap = JSON.parse(snapContent)
    assert.equal(snap.sessions[0].name, 'name_15')
    assert.equal(snap.appliedCommitSeq, 15)

    const restarted = new ControlStore(paths, 'host-test', 5)
    await restarted.init()
    assert.equal(restarted.state.sessions[0]?.name, 'name_15')
    assert.equal(restarted.state.commitSeq, 15)

    await restarted.saveSession({
      hostId: 'host-test',
      sessionId: 's1',
      cwd: root,
      createdAt: new Date().toISOString(),
      name: 'name_16',
      configuration: {},
      status: 'idle',
    })
    assert.equal(restarted.state.commitSeq, 16)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('session_receipt_upsert 原子提交保证：单 JournalEntry 提交两者，故障时绝不产生半对更新', async (_t) => {
  const { paths, store } = await fixture(_t)

  const session = {
    hostId: 'host-test',
    sessionId: 's-pair',
    cwd: '/test/cwd',
    createdAt: new Date().toISOString(),
    name: 'initial_name',
    configuration: {},
    status: 'idle' as const,
  }
  await store.saveSession(session)

  const modifiedSession = { ...session, status: 'running' as const }
  const receipt: SubmissionReceipt = {
    operationId: 'op-pair',
    submissionId: 'sub-pair',
    session: { hostId: 'host-test', sessionId: 's-pair' },
    delivery: 'start',
    status: 'running',
  }

  await rm(store.paths.controlEventsFile)
  await mkdir(store.paths.controlEventsFile)

  try {
    await assert.rejects(
      store.publish({ type: 'submission', sessionId: 's-pair', value: receipt }, modifiedSession),
      /EISDIR/,
    )

    assert.equal(store.state.sessions.find((s) => s.sessionId === 's-pair')?.status, 'idle', 'session 未被单独提交')
    assert.equal(
      store.state.receipts.find((r) => r.operationId === 'op-pair'),
      undefined,
      'receipt 未被单独提交',
    )
  } finally {
    await rm(store.paths.controlEventsFile, { recursive: true, force: true })
  }

  const store2 = new ControlStore(paths, 'host-test')
  await store2.init()

  await store2.publish({ type: 'submission', sessionId: 's-pair', value: receipt }, modifiedSession)

  const eventsContent = await readFile(paths.controlEventsFile, 'utf8')
  const lines = eventsContent.trim().split('\n')
  const lastEntry = JSON.parse(lines[lines.length - 1]!)
  assert.equal(lastEntry.mutation.kind, 'session_receipt_upsert')
  assert.equal(lastEntry.mutation.session.status, 'running')
  assert.equal(lastEntry.mutation.receipt.status, 'running')

  const restarted = new ControlStore(paths, 'host-test')
  await restarted.init()
  assert.equal(restarted.state.sessions.find((s) => s.sessionId === 's-pair')?.status, 'interrupted')
  assert.equal(restarted.state.receipts.find((r) => r.operationId === 'op-pair')?.status, 'interrupted')
})

test('app-control 无变化查询读操作零写入，会话删除 API 闭环清理', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-app-control-rw-'))
  try {
    const controlPaths = createControlStorePaths(path.join(root, 'state/control'))
    const mockSessionKey = 'session-key-1'
    const control = await createAppControl({
      hostId: 'host-test',
      root,
      controlPaths,
      goals: { list: () => [], get: () => undefined, currentRun: () => undefined, subscribe: () => () => {} } as any,
      pi: {
        getRuntimeSessions: () => [
          {
            id: mockSessionKey,
            cwd: root,
            path: 'session-file-1.jsonl',
            running: false,
            created: new Date().toISOString(),
            name: 'S1',
          },
        ],
        readSessionBinding: () => ({ cwd: root, sessionFile: 'session-file-1.jsonl', state: {} }),
        createClientView: () => ({ sessionKey: mockSessionKey }),
        withClientView: async (_view: any, fn: any) => fn(),
        releaseClientView: () => {},
      } as any,
      projects: {
        list: async () => [{ cwd: root, name: 'RootProj' }],
        kind: () => 'project',
        sourceProjectCwd: (cwd: string) => cwd,
      } as any,
      sessions: {
        getSnapshot: async () => ({
          projects: [
            {
              cwd: root,
              sessions: [{ path: 'session-file-1.jsonl', cwd: root, created: new Date().toISOString(), name: 'S1' }],
            },
          ],
          recents: [],
        }),
      } as any,
      collaboration: { goalReady: async () => true, respondExtensionUI: async () => {} } as any,
      bindRoot: async () => {},
      configureAgentPlugins: async () => {},
      defaultAgentPlugins: { getDefaultAgentPlugins: async () => [] } as any,
      snapshot: async () => ({}) as any,
      workspace: { files: {} as any, terminal: {} as any, terminalSupported: false },
      onError: () => {},
    })

    // 初始状态生成
    await control.api.projects.list()
    const snapStat1 = await stat(controlPaths.controlSnapshotFile)
    const eventsStat1 = await stat(controlPaths.controlEventsFile)

    await delay(15)
    // 再次调用只读 list 与 get，不产生任何文件更新
    await control.api.projects.list()
    await control.api.sessions.list()

    const snapStat2 = await stat(controlPaths.controlSnapshotFile)
    const eventsStat2 = await stat(controlPaths.controlEventsFile)
    assert.equal(snapStat2.mtimeMs, snapStat1.mtimeMs, '只读 list 查询未写入快照')
    assert.equal(eventsStat2.mtimeMs, eventsStat1.mtimeMs, '只读 list 查询未写入事件日志')

    // 测试会话删除 API
    const deleted = await control.deleteSessions({
      deletedPaths: ['session-file-1.jsonl'],
      deletedKeys: [mockSessionKey],
    })
    assert.equal(deleted.deletedSessionIds.length, 1)
    assert.equal(control.store.state.sessions.length, 0, '会话已从 store 中移除')

    // 验证再次重启后被删除的会话不再出现
    const restarted = new ControlStore(controlPaths, 'host-test')
    await restarted.init()
    assert.equal(restarted.state.sessions.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('临时会话在 ControlStore 中全程零落盘：无 session_upsert、无 operations、无 snapshot 记录，关闭后彻底清除', async (t) => {
  const { paths, store } = await fixture(t)
  const tempSession: any = {
    hostId: 'host-test',
    sessionId: 'temp-session-id',
    cwd: '/tmp/temp-cwd',
    createdAt: new Date().toISOString(),
    configuration: {},
    status: 'idle',
    temporary: true,
  }

  // 1. saveSession 不向 events.jsonl 写 session_upsert
  await store.saveSession(tempSession)
  assert.equal(store.state.sessions.find((s) => s.sessionId === 'temp-session-id')?.temporary, true)
  let eventsContent = await readFile(paths.controlEventsFile, 'utf8').catch(() => '')
  assert.ok(!eventsContent.includes('temp-session-id'), 'events.jsonl 不包含临时会话 session_upsert')

  // 2. mutate 对临时会话操作不向 operations.jsonl 写明文
  let actionCalled = false
  const mutateResult = await store.mutate(
    'client-1',
    'idemp-1',
    'sessions.submit',
    [{ sessionId: 'temp-session-id', text: '机密临时提问' }],
    async (opId) => {
      actionCalled = true
      return { operationId: opId, ok: true }
    },
    { ephemeral: true },
  )
  assert.ok(actionCalled)
  assert.equal(mutateResult.ok, true)
  const opsContent = await readFile(paths.controlOperationsFile, 'utf8').catch(() => '')
  assert.ok(!opsContent.includes('temp-session-id'), 'operations.jsonl 不包含临时会话操作')
  assert.ok(!opsContent.includes('机密临时提问'), 'operations.jsonl 不包含临时会话输入')

  // 3. publish 对临时会话事件只做内存广播，不追加 events.jsonl
  let broadcastReceived: HostControlEvent | undefined
  const unsubscribe = store.subscribe({}, (event) => {
    broadcastReceived = event
  })
  const receipt: SubmissionReceipt = {
    operationId: 'op-1',
    submissionId: 'sub-1',
    session: { hostId: 'host-test', sessionId: 'temp-session-id' },
    delivery: 'start',
    status: 'accepted',
  }
  await store.publish({ type: 'submission', sessionId: 'temp-session-id', value: receipt }, tempSession)
  assert.ok(broadcastReceived)
  assert.equal(broadcastReceived?.sessionId, 'temp-session-id')
  eventsContent = await readFile(paths.controlEventsFile, 'utf8').catch(() => '')
  assert.ok(!eventsContent.includes('temp-session-id'), 'events.jsonl 不包含临时提交回执')
  unsubscribe()

  // 4. checkpoint 快照排查临时会话与临时回执
  await store.checkpoint()
  const snapContent = JSON.parse(await readFile(paths.controlSnapshotFile, 'utf8'))
  assert.ok(!snapContent.sessions.some((s: any) => s.sessionId === 'temp-session-id'), '快照不含临时会话')
  assert.ok(!snapContent.receipts.some((r: any) => r.session.sessionId === 'temp-session-id'), '快照不含临时回执')

  // 5. deleteSession 清除内存且不向 events.jsonl 写 session_delete
  await store.deleteSession('temp-session-id')
  assert.equal(
    store.state.sessions.find((s) => s.sessionId === 'temp-session-id'),
    undefined,
  )
  eventsContent = await readFile(paths.controlEventsFile, 'utf8').catch(() => '')
  assert.ok(!eventsContent.includes('temp-session-id'), 'events.jsonl 不含 session_delete')
})

test('幂等冲突回归：临时操作复用普通操作 key 发生冲突时不误将普通操作标记为 ephemeral，checkpoint 保留普通操作', async (t) => {
  const { paths, store } = await fixture(t)

  // 1. 执行普通持久操作
  await store.mutate('client-fixed', 'key-dup', 'normal.op', [{ val: 'persistent-input' }], async () => {
    return { status: 'ok', data: 'persistent-val' }
  })
  let ops = await readFile(paths.controlOperationsFile, 'utf8')
  assert.ok(ops.includes('persistent-val'), '初始 operations.jsonl 包含普通操作')

  // 2. 模拟以相同 key 发起临时操作，但参数不同触发 idempotency-conflict
  await assert.rejects(
    store.mutate(
      'client-fixed',
      'key-dup',
      'temp.op',
      [{ val: 'different-temp-input' }],
      async () => ({ status: 'temp-val' }),
      { ephemeral: true },
    ),
    (e: any) => e instanceof ControlError && e.code === 'idempotency-conflict',
  )

  // 3. 执行 checkpoint，验证原普通操作绝未被当做 ephemeral 漏写
  await store.checkpoint()
  ops = await readFile(paths.controlOperationsFile, 'utf8')
  assert.ok(ops.includes('persistent-val'), 'checkpoint 后普通操作依然完整保留在 operations.jsonl')
})

test('跨窗口隔离回归：临时会话事件仅广播给其 ownerClientId 订阅者，其他窗口零泄漏', async (t) => {
  const { store } = await fixture(t)
  const tempSession: any = {
    hostId: 'host-test',
    sessionId: 'session-isolated',
    cwd: '/tmp/isolated',
    createdAt: new Date().toISOString(),
    configuration: {},
    status: 'idle',
    temporary: true,
    ownerClientId: 'window-owner-123',
  }
  await store.saveSession(tempSession)

  const ownerEvents: HostControlEvent[] = []
  const otherEvents: HostControlEvent[] = []

  const unOwner = store.subscribe({}, (e) => ownerEvents.push(e), 'window-owner-123')
  const unOther = store.subscribe({}, (e) => otherEvents.push(e), 'window-stranger-456')

  const receipt: SubmissionReceipt = {
    operationId: 'op-iso',
    submissionId: 'sub-iso',
    session: { hostId: 'host-test', sessionId: 'session-isolated' },
    delivery: 'start',
    status: 'accepted',
  }
  await store.publish({ type: 'submission', sessionId: 'session-isolated', value: receipt }, tempSession)

  assert.equal(ownerEvents.length, 1, 'Owner 窗口正常收到事件')
  assert.equal(ownerEvents[0]?.sessionId, 'session-isolated')
  assert.equal(otherEvents.length, 0, '陌生窗口零泄漏，收不到任何临时会话事件')

  unOwner()
  unOther()
})

test('防伪造订阅身份回归：subscribe 忽略 input 中的伪造 clientId，只信任服务端透传的 clientId', async (t) => {
  const { store } = await fixture(t)
  const tempSession: any = {
    hostId: 'host-test',
    sessionId: 'session-spoof-guard',
    cwd: '/tmp/spoof',
    createdAt: new Date().toISOString(),
    configuration: {},
    status: 'idle',
    temporary: true,
    ownerClientId: 'window-owner-123',
  }
  await store.saveSession(tempSession)

  const attackerEvents: HostControlEvent[] = []
  // 攻击者试图在 EventSubscription input 中附加伪造的 clientId: 'window-owner-123'
  const unAttacker = store.subscribe(
    { clientId: 'window-owner-123' } as any,
    (e) => attackerEvents.push(e),
    'attacker-client-789',
  )

  const receipt: SubmissionReceipt = {
    operationId: 'op-spoof',
    submissionId: 'sub-spoof',
    session: { hostId: 'host-test', sessionId: 'session-spoof-guard' },
    delivery: 'start',
    status: 'accepted',
  }
  await store.publish({ type: 'submission', sessionId: 'session-spoof-guard', value: receipt }, tempSession)

  assert.equal(attackerEvents.length, 0, '攻击者通过 input 冒充 ownerClientId 被完全拦截，收不到任何临时事件')
  unAttacker()
})

test('临时操作内存清理：无 session 结果的操作（如配置/目标/终端）随 deleteSession 彻底从 operations 移除，且支持幂等二次清理', async (t) => {
  const { paths, store } = await fixture(t)
  const tempSession: any = {
    hostId: 'host-test',
    sessionId: 'session-no-res-prop',
    cwd: '/tmp/no-res',
    createdAt: new Date().toISOString(),
    configuration: {},
    status: 'idle',
    temporary: true,
  }
  await store.saveSession(tempSession)

  // 1. 发起关联该临时会话的操作，但结果中完全不包含 session 或 sessionId 属性
  const opResult = await store.mutate(
    'client-1',
    'key-config-no-session-prop',
    'sessions.configure',
    [{ hostId: 'host-test', sessionId: 'session-no-res-prop' }, { model: { id: 'test' } }],
    async () => ({ ok: true, revision: 'rev-test-123' }), // 模拟返回纯配置/修改结果
    { sessionId: 'session-no-res-prop' },
  )
  assert.equal(opResult.ok, true)

  const opId = JSON.stringify(['client-1', 'key-config-no-session-prop'])
  assert.ok(store.state.operations[opId], '操作在执行后暂存在 state.operations 中')

  // 确认 operations.jsonl 未落盘
  const opsContent = await readFile(paths.controlOperationsFile, 'utf8').catch(() => '')
  assert.ok(!opsContent.includes('key-config-no-session-prop'), '临时操作不落盘')

  // 2. 删除临时会话
  await store.deleteSession('session-no-res-prop')

  // 3. 断言 operations 内存已被彻底清除，即使结果中没有 session 属性
  assert.equal(store.state.operations[opId], undefined, '无 session 结果的操作在 deleteSession 后被彻底移除')

  // 4. 幂等性测试：重复调用 deleteSession 不抛错，且绝不向 events.jsonl 追加 session_delete
  await store.deleteSession('session-no-res-prop')
  const eventsContent = await readFile(paths.controlEventsFile, 'utf8').catch(() => '')
  assert.ok(!eventsContent.includes('session-no-res-prop'), '二次 deleteSession 绝不向 events.jsonl 写 session_delete')
})

test('防伪造 temporary 字段回归：入参自报 temporary: true 不被当做 ephemeral，操作依然写入 operations.jsonl', async (t) => {
  const { paths, store } = await fixture(t)

  // 客户端在尚未注册的创建入参中恶意附加 temporary: true
  await store.mutate(
    'client-attacker',
    'key-spoof-temporary',
    'sessions.create',
    [{ name: 'persisted-session', temporary: true }],
    async () => ({ sessionId: 'persisted-123', name: 'persisted-session' }),
  )

  const opsContent = await readFile(paths.controlOperationsFile, 'utf8')
  assert.ok(opsContent.includes('key-spoof-temporary'), '自报 temporary 无法绕过持久化审计，正常写入 operations.jsonl')
})

test('app-control deleteSessions 终端清理故障与重试：终端关闭失败必须传播错误且保留 tracking，重试成功后清理并幂等', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-app-control-terminal-fail-'))
  try {
    const controlPaths = createControlStorePaths(path.join(root, 'state/control'))
    const mockSessionKey = 'temp-term-session-key'
    let shouldFailClose = true
    let closeCallCount = 0

    const { createAppControl } = await import('../src/app-control')
    const control = await createAppControl({
      hostId: 'host-test',
      root,
      controlPaths,
      goals: { list: () => [], get: () => undefined, currentRun: () => undefined, subscribe: () => () => {} } as any,
      pi: {
        getRuntimeSessions: () => [],
        readSessionBinding: () => ({ cwd: root, sessionFile: undefined, state: {} }),
        createClientView: () => ({ sessionKey: mockSessionKey }),
        withClientView: async (_view: any, fn: any) => fn(),
        releaseClientView: () => {},
        initializeClient: () => {},
      } as any,
      projects: {
        list: async () => [{ cwd: root, name: 'RootProj' }],
        kind: () => 'project',
        sourceProjectCwd: (cwd: string) => cwd,
      } as any,
      sessions: {
        getSnapshot: async () => ({
          projects: [],
          recents: [],
        }),
      } as any,
      collaboration: { goalReady: async () => true, respondExtensionUI: async () => {} } as any,
      bindRoot: async () => {},
      configureAgentPlugins: async () => {},
      defaultAgentPlugins: { getDefaultAgentPlugins: async () => [] } as any,
      snapshot: async () => ({}) as any,
      workspace: {
        files: {} as any,
        terminal: {
          open: async () => ({
            hostId: 'host-test',
            terminalId: 'term-mock-1',
            cwd: root,
            cols: 80,
            rows: 24,
            output: '',
            outputSequence: 0,
            exited: false,
          }),
          close: async () => {
            closeCallCount++
            if (shouldFailClose) throw new Error('底层终端关闭失败（模拟进程卡死）')
          },
        } as any,
        terminalSupported: true,
      },
      onError: () => {},
    })

    const tempSession: any = {
      hostId: 'host-test',
      sessionId: 'temp-session-term-test',
      cwd: root,
      createdAt: new Date().toISOString(),
      configuration: {},
      status: 'idle',
      temporary: true,
      ownerClientId: 'owner-term-client',
    }
    await control.registerTemporarySession(tempSession, mockSessionKey)

    // 打开一个终端，绑定到临时会话
    const client = control.apiFor('owner-term-client')
    await client.terminal.open(
      { hostId: 'host-test', sessionId: 'temp-session-term-test' },
      {},
      { idempotencyKey: 'open-term-1' },
    )

    // 第一次尝试 deleteSessions：终端 close 失败，必须抛出错误且保留终端 tracking
    shouldFailClose = true
    await assert.rejects(
      control.deleteSessions({
        deletedPaths: [],
        deletedKeys: [],
        deletedSessionIds: ['temp-session-term-test'],
      }),
      /底层终端关闭失败/,
      '终端关闭失败必须向外传播错误，不能静默吞掉',
    )
    assert.equal(closeCallCount, 1)

    // 恢复正常并重试 deleteSessions
    shouldFailClose = false
    const deleteResult = await control.deleteSessions({
      deletedPaths: [],
      deletedKeys: [],
      deletedSessionIds: ['temp-session-term-test'],
    })
    assert.deepEqual(deleteResult.deletedSessionIds, ['temp-session-term-test'])
    assert.equal(closeCallCount, 2, '重试时成功再次调用终端关闭')

    // 第三次幂等调用 deleteSessions：不应再次调用终端 close，不抛错
    const idempotentResult = await control.deleteSessions({
      deletedPaths: [],
      deletedKeys: [],
      deletedSessionIds: ['temp-session-term-test'],
    })
    assert.deepEqual(idempotentResult.deletedSessionIds, ['temp-session-term-test'])
    assert.equal(closeCallCount, 2, '已清理的终端不会重复执行关闭')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
