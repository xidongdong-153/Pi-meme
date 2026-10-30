import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fixture, key, eventually, finished, session } from './app-control-fixture'

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
