import assert from 'node:assert/strict'
import { test } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { SdkSession } from '../src/sdk/session'
import { fixture, until } from './pause-queue-fixture'

test('重新打开停止的会话后仍保留恢复入口和未执行队列', async () => {
  const f = await fixture(() => ({ text: '执行结果', delayMs: 200 }))
  let restored: SdkSession | undefined
  try {
    await f.session.prompt('原任务')
    await until(() => f.fake.provider.requests.length === 1)
    await f.session.followUp('等待确认的任务')
    await f.session.stopTask()
    const file = f.session.getActiveSession().sessionFile!
    await f.session.stopAndWait()
    restored = new SdkSession(
      f.fake.runtimePaths.dataRoot,
      { connection: () => {}, error: () => {}, event: () => {} },
      f.fake.runtimePaths,
      f.fake.credentials,
    )
    restored.start(f.fake.runtimePaths.dataRoot, file)
    const snapshot = await restored.snapshot()
    assert.equal(snapshot.state.stopped, true)
    assert.equal(snapshot.state.queuePaused, true)
    assert.equal(snapshot.state.pendingMessageCount, 1)
    await restored.continueStopped()
    await until(async () => !(await restored!.snapshot()).state.isStreaming)
    const continued = await restored.snapshot()
    assert.equal(continued.state.stopped, false)
    assert.equal(continued.state.queuePaused, true)
    assert.equal(continued.state.pendingMessageCount, 1)
  } finally {
    await restored?.stopAndWait()
    await f.dispose()
  }
})

test('暂停冻结流式视图，恢复保持同一请求；旧修订不能重新暂停，停止释放门控', async () => {
  const f = await fixture(() => ({ text: '恢复前已发出的正文', delayMs: 100 }))
  try {
    await f.session.prompt('初始任务')
    await until(() => f.fake.provider.requests.length === 1)
    await f.session.setPaused(true, 2)
    const paused = await f.session.snapshot()
    await delay(180)
    assert.deepEqual((await f.session.snapshot()).messages, paused.messages)
    assert.equal((await f.session.snapshot()).state.isStreaming, true)
    assert.equal((await f.session.snapshot()).state.queuePaused, true)
    await f.session.setPaused(false, 3)
    await f.session.setPaused(true, 2)
    await until(async () => !(await f.session.snapshot()).state.isStreaming)
    assert.equal(f.fake.provider.requests.length, 1)
    assert.equal((await f.session.snapshot()).state.isPaused, false)
    await f.session.prompt('停止任务')
    await f.session.pause()
    await f.session.abort()
  } finally {
    await f.dispose()
  }
})

test('FIFO保留图片、模式和id；编辑队首阻止出队，跨客户端操作拒绝，释放后逐条执行', async () => {
  const f = await fixture((_body, index) => ({ text: `完成${index}`, holdMs: index === 1 ? 100 : 0 }))
  try {
    await f.session.prompt('初始任务')
    const image = {
      type: 'image' as const,
      mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFbkAAAAASUVORK5CYII=',
    }
    await f.session.followUp('', [image])
    await f.session.followUp('计划输入', undefined, [], { mode: 'plan' })
    const [first, second] = f.queue()
    assert.ok(first && second)
    assert.deepEqual(first.images, [image])
    await f.session.beginQueueEdit(first.id, '甲')
    await assert.rejects(f.session.beginQueueEdit(first.id, '乙'), /正在编辑/)
    await assert.rejects(f.session.cancelQueueEdit(first.id, '乙'), /编辑权/)
    await delay(180)
    assert.equal(f.fake.provider.requests.length, 1)
    assert.equal(f.queue()[0]?.id, first.id)
    await f.session.updateQueueInput(first.id, '修改后的图片输入', [image], [], { mode: 'default' }, '甲')
    await until(async () => f.fake.provider.requests.length === 3 && !(await f.session.snapshot()).state.isStreaming)
    assert.equal(f.queue().length, 0)
    assert.ok(JSON.stringify(f.fake.provider.requests[1]).includes('修改后的图片输入'))
    assert.ok(JSON.stringify(f.fake.provider.requests[1]).includes('image_url'))
    assert.ok(JSON.stringify(f.fake.provider.requests[2]).includes('计划输入'))
    await assert.rejects(f.session.deleteQueueInput(second.id), /已发送/)
  } finally {
    await f.dispose()
  }
})
