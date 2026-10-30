import assert from 'node:assert/strict'
import { test, describe, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AppSession, HostApi, HostControlEvent, SubmissionReceipt } from '@pi-meme/contracts/app-host'
import { createAppControl } from '../src/app-control'
import { createHost } from '../src/service'
import { finishAgentReply, useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { requestText } from '../../../tests/fixtures/fake-provider.mjs'
import type { SessionSelectionResult } from '@pi-meme/contracts/desktop'
import { trustPluginFixture, writeAgentFixture } from './plugin-fixture'

type FakeReply = NonNullable<Parameters<typeof useFakeAgent>[1]>['reply']
async function fixture(reply?: FakeReply) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-app-control-')))
  const fake = await useFakeAgent(root, { reply })
  const dataRoot = fake.runtimePaths.dataRoot
  let host = await createHost({ dataRoot, credentials: fake.credentials })
  return {
    root,
    fake,
    dataRoot,
    get host() {
      return host
    },
    async restart() {
      await host.dispose()
      host = await createHost({ dataRoot, credentials: fake.credentials })
      return host
    },
    async dispose() {
      await host.dispose()
      await fake.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
const key = (idempotencyKey: string) => ({ idempotencyKey })
async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 12000
  let value = await read()
  while (!ready(value)) {
    if (Date.now() > deadline) throw new Error(`控制协议等待超时：${JSON.stringify(value)}`)
    await delay(10)
    value = await read()
  }
  return value
}
function finished(receipt: SubmissionReceipt) {
  return ['completed', 'failed', 'interrupted', 'cancelled'].includes(receipt.status)
}
async function session(api: HostApi, project: import('@pi-meme/contracts/app-host').ProjectRef, name: string) {
  return api.sessions.create(
    { project, name, configuration: { model: { provider: 'fake', id: 'first' }, accessMode: 'full-access' } },
    key(`create-${name}`),
  )
}

async function temporaryControlFixture(t: import('vitest').TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-temporary-control-'))
  const state = { closing: false }
  const snapshot = vi.fn(async () => ({}) as any)
  const closeTerminal = vi.fn(async () => {})
  const control = await createAppControl({
    hostId: 'host-test',
    root,
    goals: { list: () => [], get: () => undefined, flush: async () => {} } as any,
    pi: {
      getRuntimeSessions: () => [],
      getSessionContext: () => ({}),
      readSessionBinding: () => ({ cwd: root, state: {} }),
      createClientView: () => ({}),
      withClientView: async (_view: any, action: () => unknown) => action(),
      releaseClientView: () => {},
    } as any,
    projects: { list: async () => [], kind: () => 'standalone' } as any,
    sessions: { getSnapshot: async () => ({ projects: [], recents: [] }) } as any,
    collaboration: {} as any,
    bindRoot: async () => {},
    configureAgentPlugins: async () => {},
    defaultAgentPlugins: { getDefaultAgentPlugins: async () => [] } as any,
    snapshot,
    workspace: {
      files: {} as any,
      terminal: {
        open: async () => ({ hostId: 'host-test', terminalId: 'temporary-terminal' }),
        attach: async () => ({}),
        close: closeTerminal,
      } as any,
      terminalSupported: true,
    },
    isSessionClosing: () => state.closing,
    onError: () => {},
  })
  t.onTestFinished(async () => {
    await control.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const ref: AppSession = {
    hostId: 'host-test',
    sessionId: 'temporary-session',
    cwd: root,
    createdAt: new Date().toISOString(),
    configuration: {},
    status: 'idle',
    temporary: true,
    ownerClientId: 'owner',
  }
  await control.registerTemporarySession(ref, 'temporary:runtime')
  return { control, ref, state, snapshot, closeTerminal, owner: control.apiFor('owner') }
}

test('临时会话解析运行时期间开始关闭，HostApi 不再执行后续目标操作', async (t) => {
  const f = await temporaryControlFixture(t)
  const pending = f.owner.plans.list(f.ref)
  f.state.closing = true
  await assert.rejects(pending, /临时会话正在关闭/)
  assert.equal(f.snapshot.mock.calls.length, 0)
})

test('临时会话终端关闭失败后保留所有权校验，删除会话时仍会重试关闭', async (t) => {
  const f = await temporaryControlFixture(t)
  const terminal = await f.owner.terminal.open(f.ref, {}, key('open-terminal'))
  f.closeTerminal.mockRejectedValueOnce(new Error('模拟终端关闭失败'))
  await assert.rejects(f.owner.terminal.close(terminal, key('close-terminal')), /模拟终端关闭失败/)
  assert.throws(() => f.control.apiFor('another-client').terminal.attach(terminal), /无权访问其他窗口的临时会话/)
  await f.control.deleteSessions({ deletedPaths: [], deletedKeys: [], deletedSessionIds: [f.ref.sessionId] })
  assert.equal(f.closeTerminal.mock.calls.length, 2)
})

test('临时会话回执仅所属窗口可读，关闭开始后停止读取', async (t) => {
  const f = await temporaryControlFixture(t)
  const receipt: SubmissionReceipt = {
    operationId: 'temporary-operation',
    submissionId: 'temporary-submission',
    session: f.ref,
    delivery: 'start',
    status: 'completed',
  }
  await f.control.store.publish({ type: 'submission', sessionId: f.ref.sessionId, value: receipt })
  assert.deepEqual(await f.owner.sessions.receipt(receipt.operationId), receipt)
  await assert.rejects(
    f.control.apiFor('another-client').sessions.receipt(receipt.operationId),
    /无权访问其他窗口的临时会话/,
  )
  f.state.closing = true
  await assert.rejects(f.owner.sessions.receipt(receipt.operationId), /临时会话正在关闭/)
})

test('登记自定义项目名称后重启保留，不创建会话或切换当前目录', async () => {
  const f = await fixture()
  try {
    const cwd = path.join(f.root, 'custom-project')
    await mkdir(cwd)
    const previousCwd = f.host.pi.cwd
    const previousSessions = await f.host.app.sessions.list()
    const project = await f.host.app.projects.register({ cwd, name: '我的项目' }, key('custom-project'))
    assert.equal(project.name, '我的项目')
    assert.equal(project.cwd, cwd)
    assert.equal(f.host.pi.cwd, previousCwd)
    assert.deepEqual(await f.host.app.sessions.list(), previousSessions)
    await f.restart()
    assert.equal((await f.host.app.projects.get(project)).name, '我的项目')
    assert.equal((await f.host.app.projects.get(project)).cwd, cwd)
  } finally {
    await f.dispose()
  }
})

test('空会话保持不同稳定ref，同一项目目标隔离，提交幂等且冲突键拒绝', { timeout: 25000 }, async () => {
  const f = await fixture('目标回复')
  try {
    const api = f.host.app
    const cwd = path.join(f.root, 'project')
    await mkdir(cwd)
    const project = await api.projects.register({ cwd }, key('project'))
    const first = await api.sessions.create({ project }, key('empty-a'))
    const second = await api.sessions.create({ project }, key('empty-b'))
    assert.notEqual(first.sessionId, second.sessionId)
    assert.equal(first.sessionFile, undefined)
    assert.equal(second.sessionFile, undefined)
    assert.equal((await api.sessions.snapshot(first)).messages.length, 0)
    assert.equal((await api.sessions.snapshot(second)).messages.length, 0)
    await api.sessions.configure(
      first,
      { model: { provider: 'fake', id: 'first' }, accessMode: 'full-access' },
      key('configure-a'),
    )
    const input = { delivery: 'start' as const, text: '仅提交到第一个会话' }
    const [left, right] = await Promise.all([
      api.sessions.submit(first, input, key('same-submit')),
      api.sessions.submit(first, input, key('same-submit')),
    ])
    assert.equal(left.operationId, right.operationId)
    assert.equal(left.submissionId, right.submissionId)
    await eventually(() => api.sessions.receipt(left.operationId), finished)
    assert.equal(f.fake.provider.requests.length, 1)
    assert.equal((await api.sessions.submissions(first)).length, 1)
    assert.match(JSON.stringify((await api.sessions.snapshot(first)).messages), /仅提交到第一个会话/)
    assert.equal((await api.sessions.snapshot(second)).messages.length, 0)
    assert.equal((await api.sessions.get(first)).sessionId, first.sessionId)
    assert.ok((await api.sessions.get(first)).sessionFile)
    await assert.rejects(api.sessions.submit(second, input, key('same-submit')), /幂等键已经用于不同内容/)
    await assert.rejects(api.sessions.snapshot({ ...first, hostId: 'another-host' }), /服务身份不匹配/)
    await f.restart()
    assert.equal((await f.host.app.sessions.get(first)).sessionId, first.sessionId)
    assert.equal((await f.host.app.sessions.get(second)).sessionId, second.sessionId)
    assert.equal((await f.host.app.sessions.snapshot(second)).messages.length, 0)
    assert.match(JSON.stringify((await f.host.app.sessions.history(first)).messages), /仅提交到第一个会话/)
  } finally {
    await f.dispose()
  }
})

test('恢复已有会话保留已卸载的插件选择，只阻止执行；读历史与显式取消选择仍可用', { timeout: 30000 }, async () => {
  const f = await fixture('恢复后回复')
  try {
    const pluginId = 'restore-unavailable-agent'
    const plugin = path.join(f.root, 'plugin')
    await writeAgentFixture(plugin, pluginId, 'export function activate() {}')
    await f.host.plugins.loadDirectory(plugin)
    await trustPluginFixture(f.host.plugins, pluginId)
    const cwd = path.join(f.root, 'project')
    await mkdir(cwd)
    const project = await f.host.app.projects.register({ cwd }, key('restore-project'))
    const ref = await session(f.host.app, project, 'unavailable-agent')
    await f.host.app.sessions.configure(ref, { agentPlugins: [pluginId] }, key('restore-select'))
    const first = await f.host.app.sessions.submit(
      ref,
      { delivery: 'start', text: '卸载前的历史输入' },
      key('restore-first'),
    )
    assert.equal((await eventually(() => f.host.app.sessions.receipt(first.operationId), finished)).status, 'completed')
    const before = await f.host.app.sessions.snapshot(ref)
    await f.host.plugins.remove(pluginId)
    await f.restart()
    assert.deepEqual((await f.host.app.sessions.get(ref)).configuration.agentPlugins, [pluginId])
    assert.deepEqual((await f.host.app.sessions.history(ref)).messages, before.messages)
    assert.deepEqual((await f.host.app.sessions.get(ref)).configuration.agentPlugins, [pluginId])
    assert.deepEqual((await f.host.app.sessions.snapshot(ref)).messages, before.messages)
    assert.equal(f.fake.provider.requests.length, 1)
    const explicitSelection = { agentPlugins: [pluginId], restore: true }
    await assert.rejects(
      f.host.app.sessions.configure(ref, explicitSelection, key('unavailable-new-selection')),
      /Agent 插件选择无效/,
    )
    await assert.rejects(
      f.host.app.sessions.create(
        { project, configuration: { agentPlugins: [pluginId] } },
        key('unavailable-new-session'),
      ),
      /Agent 插件选择无效/,
    )
    const blocked = await f.host.app.sessions.submit(
      ref,
      { delivery: 'start', text: '不得投递的卸载后输入' },
      key('unavailable-submit'),
    )
    const failure = await eventually(() => f.host.app.sessions.receipt(blocked.operationId), finished)
    assert.equal(failure.status, 'failed')
    assert.equal(
      failure.error?.endsWith(`operation-unavailable-in-runtime: 已选择的插件 ${pluginId} 不可用：插件已卸载或不存在`),
      true,
    )
    assert.equal(f.fake.provider.requests.length, 1)
    assert.deepEqual((await f.host.app.sessions.snapshot(ref)).messages, before.messages)
    assert.deepEqual((await f.host.app.sessions.get(ref)).configuration.agentPlugins, [pluginId])
    await f.host.app.sessions.configure(ref, { agentPlugins: [] }, key('unavailable-deselect'))
    const next = await f.host.app.sessions.submit(
      ref,
      { delivery: 'start', text: '明确取消选择后的新任务' },
      key('unavailable-recover'),
    )
    assert.equal((await eventually(() => f.host.app.sessions.receipt(next.operationId), finished)).status, 'completed')
    assert.equal(f.fake.provider.requests.length, 2)
    assert.deepEqual((await f.host.app.sessions.get(ref)).configuration.agentPlugins, [])
  } finally {
    await f.dispose()
  }
})

test('queue逐条投递，撤销只移除对应提交，steer回执绑定当前run', { timeout: 25000 }, async () => {
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture((_body, index) => ({
    text: `回复${index}`,
    ...(index === 1 ? { deltaBarrier: barrier } : {}),
  }))
  try {
    const api = f.host.app
    const cwd = path.join(f.root, 'project')
    await mkdir(cwd)
    const project = await api.projects.register({ cwd }, key('project'))
    const ref = await session(api, project, 'queue')
    const first = await api.sessions.submit(ref, { delivery: 'start', text: '当前任务' }, key('start'))
    await eventually(
      () => api.sessions.receipt(first.operationId),
      (receipt) => receipt.status === 'running' && Boolean(receipt.runId),
    )
    const cancelled = await api.sessions.submit(ref, { delivery: 'queue', text: '必须撤销的输入' }, key('cancelled'))
    const queued = await api.sessions.submit(ref, { delivery: 'queue', text: '下一轮队列输入' }, key('queued'))
    assert.equal(cancelled.status, 'queued')
    assert.equal(queued.status, 'queued')
    await api.sessions.cancelSubmission(cancelled.operationId, key('cancel'))
    assert.equal((await api.sessions.receipt(cancelled.operationId)).status, 'cancelled')
    const steer = await api.sessions.submit(ref, { delivery: 'steer', text: '当前轮补充要求' }, key('steer'))
    assert.equal(steer.runId, (await api.sessions.receipt(first.operationId)).runId)
    await assert.rejects(api.sessions.cancelSubmission(first.operationId, key('invalid-cancel')), /只能撤销排队/)
    release()
    for (const receipt of [first, steer, queued])
      assert.equal((await eventually(() => api.sessions.receipt(receipt.operationId), finished)).status, 'completed')
    assert.ok(f.fake.provider.requests.some((body) => requestText(body).includes('当前轮补充要求')))
    assert.ok(f.fake.provider.requests.some((body) => requestText(body).includes('下一轮队列输入')))
    assert.ok(f.fake.provider.requests.every((body) => !requestText(body).includes('必须撤销的输入')))
  } finally {
    release()
    await f.dispose()
  }
})

test('停止目标任务取消其队列，不影响另一个会话完成；空闲steer明确拒绝', { timeout: 25000 }, async () => {
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture((body) => ({
    text: '已回复',
    ...(requestText(body).includes('保持运行的任务') ? { deltaBarrier: barrier } : {}),
  }))
  try {
    const api = f.host.app
    const cwd = path.join(f.root, 'project')
    await mkdir(cwd)
    const project = await api.projects.register({ cwd }, key('project'))
    const left = await session(api, project, 'left')
    const right = await session(api, project, 'right')
    await assert.rejects(
      api.sessions.submit(right, { delivery: 'steer', text: '空闲引导' }, key('idle-steer')),
      /会话未运行/,
    )
    const running = await api.sessions.submit(left, { delivery: 'start', text: '保持运行的任务' }, key('left-start'))
    await eventually(
      async () => f.fake.provider.requests.length,
      (count) => count >= 1,
    )
    const queued = await api.sessions.submit(left, { delivery: 'queue', text: '停止时取消队列' }, key('left-queue'))
    const independent = await api.sessions.submit(
      right,
      { delivery: 'start', text: '另一个会话继续' },
      key('right-start'),
    )
    await api.sessions.stop(left, key('stop-left'))
    assert.equal((await eventually(() => api.sessions.receipt(running.operationId), finished)).status, 'interrupted')
    assert.equal((await api.sessions.receipt(queued.operationId)).status, 'cancelled')
    assert.equal((await eventually(() => api.sessions.receipt(independent.operationId), finished)).status, 'completed')
    assert.match(JSON.stringify((await api.sessions.snapshot(right)).messages), /另一个会话继续/)
  } finally {
    release()
    await f.dispose()
  }
})

test('模型失败回执持久化为failed，同一幂等键跨重启不会重新投递', { timeout: 25000 }, async () => {
  const f = await fixture({ status: 400, text: '测试模型拒绝' })
  try {
    let api = f.host.app
    const cwd = path.join(f.root, 'project')
    await mkdir(cwd)
    const project = await api.projects.register({ cwd }, key('project'))
    const ref = await session(api, project, 'failure')
    const input = { delivery: 'start' as const, text: '触发模型失败' }
    const receipt = await api.sessions.submit(ref, input, key('submit-failure'))
    const failed = await eventually(() => api.sessions.receipt(receipt.operationId), finished)
    assert.equal(failed.status, 'failed')
    assert.match(failed.error ?? '', /测试模型拒绝|400/)
    const requests = f.fake.provider.requests.length
    await f.restart()
    api = f.host.app
    const repeated = await api.sessions.submit(ref, input, key('submit-failure'))
    assert.equal(repeated.operationId, receipt.operationId)
    assert.equal((await api.sessions.receipt(repeated.operationId)).status, 'failed')
    await delay(30)
    assert.equal(f.fake.provider.requests.length, requests)
  } finally {
    await f.dispose()
  }
})

test('控制事件订阅按目标过滤，live正文不落盘，失效epoch要求resync', { timeout: 25000 }, async () => {
  const f = await fixture({ text: '只属于 Pi JSONL 的长正文标记'.repeat(8), chunkDelayMs: 4 })
  try {
    const api = f.host.app
    const cwd = path.join(f.root, 'project')
    await mkdir(cwd)
    const project = await api.projects.register({ cwd }, key('project'))
    const ref = await session(api, project, 'events')
    const before = await api.events.read()
    const events: HostControlEvent[] = []
    const unsubscribe = await api.events.subscribe({ sessionId: ref.sessionId, after: before.cursor }, (event) =>
      events.push(event),
    )
    const receipt = await api.sessions.submit(ref, { delivery: 'start', text: '读取实时消息' }, key('events-submit'))
    await eventually(() => api.sessions.receipt(receipt.operationId), finished)
    unsubscribe()
    assert.ok(events.some((event) => event.stream === 'live'))
    assert.ok(events.every((event) => event.sessionId === ref.sessionId))
    const page = await api.events.read({ sessionId: ref.sessionId, after: before.cursor })
    assert.ok(page.events.length > 0)
    assert.ok(page.events.every((event) => event.stream === undefined))
    const data = await readFile(path.join(f.dataRoot, 'state/control/events.jsonl'), 'utf8')
    assert.doesNotMatch(data, /只属于 Pi JSONL 的长正文标记/)
    assert.match(JSON.stringify((await api.sessions.history(ref)).messages), /只属于 Pi JSONL 的长正文标记/)
    const invalid = await api.events.read({ after: { journalEpoch: 'old', seq: 0 } })
    assert.equal(invalid.resyncRequired, true)
    const resync: HostControlEvent[] = []
    ;(await api.events.subscribe({ after: { journalEpoch: 'old', seq: 0 } }, (event) => resync.push(event)))()
    assert.equal(resync[0]?.type, 'resync')
  } finally {
    await f.dispose()
  }
})

test('运行与排队提交跨Host重启标记中断，相同幂等键返回原回执并且不重放', { timeout: 25000 }, async () => {
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture({ text: '中断前正文', deltaBarrier: barrier })
  try {
    let api = f.host.app
    const cwd = path.join(f.root, 'project')
    await mkdir(cwd)
    const project = await api.projects.register({ cwd }, key('project'))
    const ref = await session(api, project, 'restart')
    const input = { delivery: 'start' as const, text: '等待重启的提交' }
    const queuedInput = { delivery: 'queue' as const, text: '重启前仍排队的提交' }
    const receipt = await api.sessions.submit(ref, input, key('before-restart'))
    await eventually(
      async () => f.fake.provider.requests.length,
      (count) => count === 1,
    )
    const queued = await api.sessions.submit(ref, queuedInput, key('queued-before-restart'))
    assert.equal(queued.status, 'queued')
    const requests = f.fake.provider.requests.length
    await f.restart()
    api = f.host.app
    const interrupted = await api.sessions.receipt(receipt.operationId)
    assert.equal(interrupted.status, 'interrupted')
    const queueInterrupted = await api.sessions.receipt(queued.operationId)
    assert.equal(queueInterrupted.status, 'interrupted')
    assert.equal(queueInterrupted.outcomeUncertain, false)
    const repeated = await api.sessions.submit(ref, input, key('before-restart'))
    assert.equal(repeated.operationId, receipt.operationId)
    assert.equal(repeated.status, 'interrupted')
    const repeatedQueue = await api.sessions.submit(ref, queuedInput, key('queued-before-restart'))
    assert.equal(repeatedQueue.operationId, queued.operationId)
    await delay(30)
    assert.equal(f.fake.provider.requests.length, requests)
  } finally {
    release()
    await f.dispose()
  }
})

test('UI修改配置后正式get同步已有运行时状态，历史get不启动Worker', { timeout: 25000 }, async () => {
  const f = await fixture('配置同步完成')
  try {
    const api = f.host.app
    const cwd = path.join(f.root, 'project')
    await mkdir(cwd)
    const project = await api.projects.register({ cwd }, key('project'))
    const ref = await session(api, project, 'ui-config')
    const runtimeKey = (await api.sessions.snapshot(ref)).connection.sessionKey!
    const rpc = (method: string, args: unknown[]) =>
      f.host.rpc({ requestId: crypto.randomUUID(), clientId: 'ui', sessionId: runtimeKey, method, args })
    assert.equal((await rpc('pi:set-thinking-level', [runtimeKey, 'high'])).error, undefined)
    assert.equal((await rpc('pi:session-mode', [runtimeKey, 'plan'])).error, undefined)
    assert.equal((await rpc('pi:access-mode', [runtimeKey, 'read-only'])).error, undefined)
    const current = await api.sessions.get(ref)
    assert.equal(current.configuration.thinkingLevel, 'high')
    assert.equal(current.configuration.mode, 'plan')
    assert.equal(current.configuration.accessMode, 'read-only')
    const receipt = await api.sessions.submit(
      ref,
      { delivery: 'start', text: '读取配置同步后的历史', mode: 'plan' },
      key('history'),
    )
    assert.equal((await eventually(() => api.sessions.receipt(receipt.operationId), finished)).status, 'completed')
    await f.restart()
    const before = f.host.pi.getRuntimeSessions().length
    const restored = await f.host.app.sessions.get(ref)
    assert.equal(restored.sessionId, ref.sessionId)
    assert.equal(restored.configuration.mode, 'plan')
    assert.equal(f.host.pi.getRuntimeSessions().length, before)
    assert.equal(before, 0)
  } finally {
    await f.dispose()
  }
})

test('运行时配置切换期间并发get保留会话映射与Agent插件选择', { timeout: 25000 }, async () => {
  const f = await fixture('配置切换完成')
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const entering = new Promise<void>((resolve) => {
    entered = resolve
  })
  let changing: Promise<void> | undefined
  try {
    const api = f.host.app
    const cwd = path.join(f.root, 'project')
    await mkdir(cwd)
    const pluginId = 'control-changing-fixture'
    const source = path.join(f.root, 'agent-plugin')
    await writeAgentFixture(source, pluginId, 'export function activate() {}')
    await f.host.plugins.loadDirectory(source)
    await trustPluginFixture(f.host.plugins, pluginId)
    const project = await api.projects.register({ cwd }, key('project'))
    const ref = await session(api, project, 'changing')
    const runtimeKey = (await api.sessions.snapshot(ref)).connection.sessionKey!
    await api.sessions.configure(ref, { agentPlugins: [pluginId] }, key('select-plugin'))
    assert.deepEqual(f.host.control.selectedAgentPlugins(runtimeKey), [pluginId])
    const runtimeCount = f.host.pi.getRuntimeSessions().length
    changing = f.host.pi.idle(async () => {
      entered()
      await barrier
    }, true)
    await entering
    assert.throws(() => f.host.pi.getSessionContext(runtimeKey), /正在修改运行时配置/)
    const results = await Promise.all(Array.from({ length: 6 }, () => api.sessions.get(ref)))
    for (const current of results) {
      assert.equal(current.sessionId, ref.sessionId)
      assert.deepEqual(current.configuration.agentPlugins, [pluginId])
    }
    assert.deepEqual(f.host.control.selectedAgentPlugins(runtimeKey), [pluginId])
    assert.equal(f.host.pi.getRuntimeSessions().length, runtimeCount)
    release()
    await changing
    assert.equal((await api.sessions.snapshot(ref)).connection.sessionKey, runtimeKey)
    assert.deepEqual(f.host.control.selectedAgentPlugins(runtimeKey), [pluginId])
  } finally {
    release()
    await changing?.catch(() => {})
    await f.dispose()
  }
})

describe('重启后直接通过UI恢复并发送，保留会话插件选择且不加载默认插件', () => {
  for (const selected of [['session-agent'], []])
    test(selected.length ? '保留已选插件' : '保留空列表', { timeout: 40000 }, async () => {
      const f = await fixture('恢复会话回复')
      try {
        const markers = new Map<string, string>()
        for (const id of ['session-agent', 'default-agent']) {
          const source = path.join(f.root, id)
          const marker = path.join(f.root, `${id}-imported`)
          markers.set(id, marker)
          await writeAgentFixture(
            source,
            id,
            `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, 'imported')
export function activate() {}`,
          )
          await f.host.plugins.loadDirectory(source)
          await trustPluginFixture(f.host.plugins, id)
        }
        const cwd = path.join(f.root, 'project')
        await mkdir(cwd)
        const project = await f.host.app.projects.register({ cwd }, key('project'))
        const ref = await session(f.host.app, project, 'restored-plugins')
        await f.host.app.sessions.configure(ref, { agentPlugins: selected }, key('select-agent'))
        const receipt = await f.host.app.sessions.submit(ref, { delivery: 'start', text: '保存会话' }, key('save'))
        assert.equal(
          (await eventually(() => f.host.app.sessions.receipt(receipt.operationId), finished)).status,
          'completed',
        )
        const saved = await f.host.app.sessions.get(ref)
        assert.ok(saved.sessionFile)
        await f.host.app.plugins.setDefaultAgentPlugins(['default-agent'], key('default-agent'))
        await f.restart()
        for (const marker of markers.values()) await rm(marker, { force: true })
        const rpc = async <T>(method: string, args: unknown[] = [], sessionId?: string) => {
          const response = await f.host.rpc({ requestId: crypto.randomUUID(), clientId: 'ui', method, args, sessionId })
          assert.equal(response.error, undefined, response.error?.message)
          return response.result as T
        }
        const restored = await rpc<SessionSelectionResult>('pi:switch-session', [saved.sessionFile])
        assert.equal(restored.cancelled, false)
        if (restored.cancelled) throw new Error('历史会话恢复已取消')
        const runtimeKey = restored.snapshot.connection.sessionKey!
        await rpc('pi:prompt', [runtimeKey, '直接发送恢复后的任务'], runtimeKey)
        await eventually(
          async () => f.fake.provider.requests.length,
          (count) => count === 2,
        )
        await eventually(async () => f.host.pi.getRuntimeSessions().every((record) => !record.running), Boolean)
        for (const [id, marker] of markers) {
          if (selected.includes(id)) assert.equal(await readFile(marker, 'utf8'), 'imported')
          else await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' })
        }
        assert.deepEqual((await f.host.app.sessions.get(ref)).configuration.agentPlugins, selected)
        assert.equal((await f.host.control.sessionForRuntime(runtimeKey)).sessionId, ref.sessionId)
      } finally {
        await f.dispose()
      }
    })
})

test('已有会话中途选择Agent插件后，后续消息无需再次引用仍保留工具和上下文', { timeout: 40000 }, async () => {
  const f = await fixture('持续使用插件完成任务')
  try {
    const api = f.host.app
    const cwd = path.join(f.root, 'project')
    await mkdir(cwd)
    const pluginId = 'mid-session-agent'
    const source = path.join(f.root, pluginId)
    await writeAgentFixture(
      source,
      pluginId,
      `export function activate(context) {
      context.tools.register({ name: 'mid_session_tool', title: '插件工具', description: '中途启用的工具', parameters: { type: 'object', properties: {} }, effect:'read',capabilities:[], execute: () => ({ text: '完成' }) })
      context.hooks.on('beforeRun', () => ({ context: '后续轮次持续保留的插件信息' }))
    }`,
    )
    await f.host.plugins.loadDirectory(source)
    await trustPluginFixture(f.host.plugins, pluginId)
    const project = await api.projects.register({ cwd }, key('project'))
    const ref = await session(api, project, 'mid-session')
    const first = await api.sessions.submit(
      ref,
      { delivery: 'start', text: '未选择插件时的第一轮' },
      key('before-plugin'),
    )
    assert.equal((await eventually(() => api.sessions.receipt(first.operationId), finished)).status, 'completed')
    assert.ok(
      !f.fake.provider.requests[0]!.tools.some(
        (tool: { function: { name: string } }) => tool.function.name === 'mid_session_tool',
      ),
    )
    await api.sessions.configure(ref, { agentPlugins: [pluginId] }, key('select-mid-session'))
    for (const index of [1, 2]) {
      const receipt = await api.sessions.submit(
        ref,
        { delivery: 'start', text: `不携带插件引用的第${index}次消息` },
        key(`after-plugin-${index}`),
      )
      assert.equal((await eventually(() => api.sessions.receipt(receipt.operationId), finished)).status, 'completed')
      const request = f.fake.provider.requests.at(-1)!
      assert.ok(request.tools.some((tool: { function: { name: string } }) => tool.function.name === 'mid_session_tool'))
      assert.match(requestText(request), /后续轮次持续保留的插件信息/)
      assert.deepEqual((await api.sessions.get(ref)).configuration.agentPlugins, [pluginId])
    }
  } finally {
    await f.dispose()
  }
})

test('并发枚举UI项目和历史会话只创建一份稳定身份', { timeout: 25000 }, async () => {
  const f = await fixture({ text: 'UI历史回复', delayMs: 40 })
  try {
    const cwd = path.join(f.root, 'project')
    await mkdir(cwd)
    const rpc = (method: string, args: unknown[] = [], sessionId?: string) =>
      f.host.rpc({ requestId: crypto.randomUUID(), clientId: 'ui', method, args, sessionId })
    const selected = (await rpc('workspace:select', [{ kind: 'project', cwd }])).result as SessionSelectionResult
    assert.equal(selected.cancelled, false)
    if (selected.cancelled) throw new Error('UI项目选择不能取消')
    const runtimeKey = selected.snapshot.connection.sessionKey!
    assert.equal((await rpc('pi:access-mode', [runtimeKey, 'full-access'], runtimeKey)).error, undefined)
    assert.equal(
      (await rpc('pi:set-model', [runtimeKey, { provider: 'fake', id: 'first' }], runtimeKey)).error,
      undefined,
    )
    assert.equal((await rpc('pi:prompt', [runtimeKey, 'UI历史任务'], runtimeKey)).error, undefined)
    await eventually(
      async () => f.fake.provider.requests.length,
      (count) => count === 1,
    )
    await eventually(async () => f.host.pi.getRuntimeSessions().every((record) => !record.running), Boolean)
    await Promise.all(Array.from({ length: 12 }, () => f.host.app.projects.list()))
    const projects = (await f.host.app.projects.list()).filter((entry) => entry.cwd === cwd)
    assert.equal(projects.length, 1)
    await Promise.all(Array.from({ length: 12 }, () => f.host.app.sessions.list({ project: projects[0] })))
    const sessions = await f.host.app.sessions.list({ project: projects[0] })
    assert.equal(sessions.length, 1)
    assert.ok(sessions[0]!.sessionFile)
    assert.equal((await f.host.app.sessions.get(sessions[0]!)).sessionId, sessions[0]!.sessionId)
  } finally {
    await f.dispose()
  }
})

test('控制日志不复制根任务与子代理task/report正文，正式Agent查询仍返回真实内容', { timeout: 25000 }, async () => {
  const rootText = '根任务正文只保留在原生会话'
  const childTask = '子代理任务正文只保留在协作存储'
  const childReport = '子代理完整报告只保留在原生会话'
  let parentRequests = 0
  const f = await fixture((body) => {
    const users = (body.messages ?? []).filter((message: { role: string }) => message.role === 'user')
    if (JSON.stringify(users).includes(childTask)) return finishAgentReply(body, childReport)
    parentRequests++
    if (parentRequests === 1)
      return {
        tool: {
          name: 'spawn_agent',
          arguments: JSON.stringify({ task_name: 'worker', message: childTask, fork_turns: 'none' }),
        },
      }
    if (parentRequests === 2)
      return { tool: { name: 'wait_agent', arguments: JSON.stringify({ targets: ['worker'], timeout_ms: 5000 }) } }
    return '父任务已完成'
  })
  try {
    const api = f.host.app
    const cwd = path.join(f.root, 'project')
    await mkdir(cwd)
    const project = await api.projects.register({ cwd }, key('project'))
    const ref = await session(api, project, 'log-sanitize')
    const receipt = await api.sessions.submit(ref, { delivery: 'start', text: rootText }, key('submit'))
    assert.equal((await eventually(() => api.sessions.receipt(receipt.operationId), finished)).status, 'completed')
    const agents = await eventually(
      () => api.agents.list(ref),
      (items) => items.some((agent) => agent.depth === 1 && agent.status === 'completed'),
    )
    const child = agents.find((agent) => agent.depth === 1)!
    assert.equal(child.task, childTask)
    assert.equal(child.report, childReport)
    assert.match(JSON.stringify((await api.agents.get(child.agentId)).messages), new RegExp(childReport))
    const page = await api.events.read({ sessionId: ref.sessionId })
    const updates = page.events.filter(
      (event) =>
        event.type === 'runtime' &&
        'event' in event.value &&
        (event.value.event as { type: string }).type === 'agents_update',
    )
    assert.ok(updates.length > 0)
    const data = await readFile(path.join(f.dataRoot, 'state/control/events.jsonl'), 'utf8')
    for (const marker of [rootText, childTask, childReport])
      assert.equal(data.includes(marker), false, '控制日志不得完整复制任务或报告正文')
  } finally {
    await f.dispose()
  }
})

test('删除崩溃恢复：无 sessionFile 的空会话在 deleted intent 状态下重启由 recoverPending 补清，prepared 未确认项安全保留', async () => {
  const f = await fixture()
  try {
    const api = f.host.app
    const cwd = path.join(f.root, 'project-crash-test')
    await mkdir(cwd)
    const project = await api.projects.register({ cwd }, key('project'))

    // 1. 创建两个合法的无 sessionFile 的空会话
    const emptyConfirmed = await api.sessions.create({ project }, key('empty-confirmed'))
    const emptyUnconfirmed = await api.sessions.create({ project }, key('empty-unconfirmed'))
    assert.equal(emptyConfirmed.sessionFile, undefined)
    assert.equal(emptyUnconfirmed.sessionFile, undefined)

    const runtimeKeyConfirmed = `runtime:${randomUUID()}`
    const runtimeKeyUnconfirmed = `runtime:${randomUUID()}`

    const maintenanceDir = path.join(f.dataRoot, 'state', 'maintenance')
    await mkdir(maintenanceDir, { recursive: true })

    // 2. 为 emptyConfirmed 写入 stage: 'deleted' 的 pending intent
    // （模拟用户已确认删除，afterDelete 已落盘，但 control 在提交 journal 前崩溃或写失败）
    const deletedIntentId = randomUUID()
    const deletedRecord = {
      version: 1,
      id: deletedIntentId,
      stage: 'deleted',
      candidatePaths: [],
      candidateKeys: [runtimeKeyConfirmed],
      canonicalKeys: [],
      sessionIdsMap: [[runtimeKeyConfirmed, emptyConfirmed.sessionId]],
      timestamp: new Date().toISOString(),
    }
    const deletedFile = path.join(maintenanceDir, `pending-cleanup-${deletedIntentId}.json`)
    await writeFile(deletedFile, JSON.stringify(deletedRecord, null, 2), 'utf8')

    // 3. 为 emptyUnconfirmed 写入 stage: 'prepared' 的 pending intent
    // （模拟用户仅进入 prepare 阶段，尚未确认删除即崩溃）
    const preparedIntentId = randomUUID()
    const preparedRecord = {
      version: 1,
      id: preparedIntentId,
      stage: 'prepared',
      candidatePaths: [],
      candidateKeys: [runtimeKeyUnconfirmed],
      canonicalKeys: [],
      sessionIdsMap: [[runtimeKeyUnconfirmed, emptyUnconfirmed.sessionId]],
      timestamp: new Date().toISOString(),
    }
    const preparedFile = path.join(maintenanceDir, `pending-cleanup-${preparedIntentId}.json`)
    await writeFile(preparedFile, JSON.stringify(preparedRecord, null, 2), 'utf8')

    // 4. 重启 Host：重启时没有任何 runtime map，createHost 在启动时自动调用 sessionCleanup.recoverPending()
    await f.restart()

    // 5. 校验：
    // - emptyConfirmed 已被 recoverPending 成功传入已授权 public sessionId 补清
    const remainingSessions = await f.host.app.sessions.list({ project })
    assert.equal(
      remainingSessions.some((s) => s.sessionId === emptyConfirmed.sessionId),
      false,
      '已确认删除的空会话必须被 recoverPending 成功补清',
    )

    // - emptyUnconfirmed 未确认删除，其 runtime key 绝不被误删，会话被安全保留
    assert.equal(
      remainingSessions.some((s) => s.sessionId === emptyUnconfirmed.sessionId),
      true,
      'prepared 状态下未确认物理删除的会话必须安全保留',
    )

    // - 两个 pending intent 文件均在恢复后被清理
    await assert.rejects(stat(deletedFile), { code: 'ENOENT' })
    await assert.rejects(stat(preparedFile), { code: 'ENOENT' })
  } finally {
    await f.dispose()
  }
})

test('计划引用提交校验归属与版本，重复请求只实施一次并保留指定配置', { timeout: 25000 }, async () => {
  const f = await fixture((_body, index) =>
    index === 1
      ? {
          tool: {
            name: 'save_plan',
            arguments: JSON.stringify({ title: '确认计划', markdown: '# 确认正文\n按这份方案实施' }),
          },
        }
      : '完成',
  )
  try {
    const api = f.host.app
    const cwd = path.join(f.root, 'plan-project')
    await mkdir(cwd)
    const project = await api.projects.register({ cwd }, key('plan-project'))
    const ref = await session(api, project, 'plan-main')
    const first = await api.sessions.submit(
      ref,
      { delivery: 'start', mode: 'plan', text: '请设计方案并保存计划' },
      key('plan-first'),
    )
    const planned = await eventually(() => api.sessions.receipt(first.operationId), finished)
    assert.equal(planned.status, 'completed', planned.error)
    const documents = await api.plans.list(ref)
    assert.equal(documents.length, 1)
    const document = documents[0]!
    const input = {
      delivery: 'start' as const,
      text: '仅实施确认计划',
      mode: 'default' as const,
      plan: { intent: 'execute' as const, reference: { id: document.id, revision: document.revision } },
      model: { provider: 'fake', id: 'first' },
      thinkingLevel: 'high' as const,
    }
    const other = await session(api, project, 'plan-other')
    await assert.rejects(api.sessions.submit(other, input, key('plan-other-submit')), /不存在/)
    await assert.rejects(
      api.sessions.submit(
        ref,
        { ...input, plan: { ...input.plan, reference: { id: document.id, revision: document.revision + 1 } } },
        key('plan-stale'),
      ),
      /新修订/,
    )
    const count = f.fake.provider.requests.length
    const [left, right] = await Promise.all([
      api.sessions.submit(ref, input, key('plan-execute')),
      api.sessions.submit(ref, input, key('plan-execute')),
    ])
    assert.equal(left.operationId, right.operationId)
    const executed = await eventually(() => api.sessions.receipt(left.operationId), finished)
    assert.equal(executed.status, 'completed', executed.error)
    assert.equal(f.fake.provider.requests.length, count + 1)
    assert.match(requestText(f.fake.provider.requests.at(-1)), /确认正文/)
    assert.equal((await api.sessions.snapshot(ref)).state.thinkingLevel, 'high')
    for (const text of ['/goal pause', '/goal 调整计划中的命令示例']) {
      const before = f.fake.provider.requests.length
      const revised = await api.sessions.submit(
        ref,
        { ...input, text, mode: 'plan', plan: { ...input.plan, intent: 'revise' } },
        key(`plan-revise-${before}`),
      )
      const result = await eventually(() => api.sessions.receipt(revised.operationId), finished)
      assert.equal(result.status, 'completed', result.error)
      assert.equal(f.fake.provider.requests.length, before + 1)
      assert.ok(requestText(f.fake.provider.requests.at(-1)).includes(text))
      assert.equal(await api.goals.get(ref), undefined)
    }
  } finally {
    await f.dispose()
  }
})

test('HostApi 接受 max 并返回当前模型实际支持的强度', async () => {
  const f = await fixture()
  try {
    const api = f.host.app
    const project = await api.projects.register({ cwd: f.root }, key('thinking-project'))
    const ref = await session(api, project, 'thinking')
    const configured = await api.sessions.configure(ref, { thinkingLevel: 'max' }, key('thinking-max'))
    assert.equal(configured.configuration.thinkingLevel, 'high')
    assert.equal((await api.sessions.snapshot(ref)).state.thinkingLevel, 'high')
    await assert.rejects(
      api.sessions.configure(ref, { thinkingLevel: 'ultra' as 'max' }, key('thinking-invalid')),
      /思考强度无效/,
    )
  } finally {
    await f.dispose()
  }
})
