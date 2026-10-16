import assert from 'node:assert/strict'
import { test, describe } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { HostApi, HostControlEvent, SubmissionReceipt } from '@pi-meme/contracts/app-host'
import { createHost } from '../src/service'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { requestText } from '../../../tests/fixtures/fake-provider.mjs'
import type { SessionSelectionResult } from '@pi-meme/contracts/desktop'

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
    await assert.rejects(api.sessions.snapshot({ ...first, hostId: 'another-host' }), /Host 身份不匹配/)
    await f.restart()
    assert.equal((await f.host.app.sessions.get(first)).sessionId, first.sessionId)
    assert.equal((await f.host.app.sessions.get(second)).sessionId, second.sessionId)
    assert.equal((await f.host.app.sessions.snapshot(second)).messages.length, 0)
    assert.match(JSON.stringify((await f.host.app.sessions.history(first)).messages), /仅提交到第一个会话/)
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
    const data = await readFile(path.join(f.dataRoot, 'control.json'), 'utf8')
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
    await mkdir(path.join(source, 'dist'), { recursive: true })
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({ name: pluginId, version: '1.0.0', piMeme: { sdkVersion: 2, agent: 'dist/agent.js' } }),
    )
    await writeFile(path.join(source, 'dist/agent.js'), 'export function activate() {}')
    await f.host.plugins.loadDirectory(source)
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
          await mkdir(path.join(source, 'dist'), { recursive: true })
          await writeFile(
            path.join(source, 'package.json'),
            JSON.stringify({
              name: id,
              version: '1.0.0',
              type: 'module',
              piMeme: { sdkVersion: 2, agent: 'dist/agent.js' },
            }),
          )
          await writeFile(
            path.join(source, 'dist/agent.js'),
            `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, 'imported')
export function activate() {}`,
          )
          await f.host.plugins.loadDirectory(source)
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
    await mkdir(path.join(source, 'dist'), { recursive: true })
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({
        name: pluginId,
        version: '1.0.0',
        type: 'module',
        piMeme: { sdkVersion: 2, agent: 'dist/agent.js' },
      }),
    )
    await writeFile(
      path.join(source, 'dist/agent.js'),
      `export function activate(context) {
      context.tools.register({ name: 'mid_session_tool', title: '插件工具', description: '中途启用的工具', parameters: { type: 'object', properties: {} }, execute: () => ({ text: '完成' }) })
      context.hooks.on('beforeRun', () => ({ context: '后续轮次持续保留的插件信息' }))
    }`,
    )
    await f.host.plugins.loadDirectory(source)
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
    if (JSON.stringify(users).includes(childTask)) return childReport
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
    const data = await readFile(path.join(f.dataRoot, 'control.json'), 'utf8')
    for (const marker of [rootText, childTask, childReport])
      assert.equal(data.includes(marker), false, '控制日志不得完整复制任务或报告正文')
  } finally {
    await f.dispose()
  }
})
