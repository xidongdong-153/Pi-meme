import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PiExtensionEvent } from '@pi-meme/contracts/pi'
import { ExtensionUiBridge } from '../src/sdk/ui-bridge'

test('ExtensionUiBridge 弹窗 confirm 正常响应与取消', async () => {
  const events: PiExtensionEvent[] = []
  const bridge = new ExtensionUiBridge((event) => events.push(event))

  // 1. 确认
  const confirmPromise = bridge.ui.confirm('确认操作', '是否继续？')
  assert.equal(events.length, 1)
  const req1 = events[0]
  assert.equal(req1.type, 'extension_ui_request')
  if (req1.type === 'extension_ui_request' && req1.method === 'confirm') {
    assert.equal(req1.title, '确认操作')
    assert.equal(req1.message, '是否继续？')
    bridge.respond(req1.id, { confirmed: true })
  }
  assert.equal(await confirmPromise, true)

  // 2. 取消
  events.length = 0
  const cancelPromise = bridge.ui.confirm('确认操作2', '是否继续？')
  const req2 = events[0]
  if (req2.type === 'extension_ui_request' && req2.method === 'confirm') {
    bridge.respond(req2.id, { cancelled: true })
  }
  assert.equal(await cancelPromise, false)
})

test('ExtensionUiBridge 弹窗 select 和 input 正常接收值', async () => {
  const events: PiExtensionEvent[] = []
  const bridge = new ExtensionUiBridge((event) => events.push(event))

  // 1. select
  const selectPromise = bridge.ui.select('请选择模式', ['快速', '深度'])
  const selectReq = events[0]
  if (selectReq.type === 'extension_ui_request' && selectReq.method === 'select') {
    assert.deepEqual(selectReq.options, ['快速', '深度'])
    bridge.respond(selectReq.id, { value: '深度' })
  }
  assert.equal(await selectPromise, '深度')

  // 2. input
  events.length = 0
  const inputPromise = bridge.ui.input('输入提交信息', 'feat: ...')
  const inputReq = events[0]
  if (inputReq.type === 'extension_ui_request' && inputReq.method === 'input') {
    assert.equal(reqValue(inputReq.placeholder), 'feat: ...')
    bridge.respond(inputReq.id, { value: 'feat: add sdk' })
  }
  assert.equal(await inputPromise, 'feat: add sdk')
})

function reqValue(val: unknown) {
  return val
}

test('ExtensionUiBridge 支持 AbortSignal 取消挂起的弹窗', async () => {
  const events: PiExtensionEvent[] = []
  const bridge = new ExtensionUiBridge((event) => events.push(event))

  // 1. 已处于 aborted 状态的信号直接返回 fallback，不发事件
  const controller1 = new AbortController()
  controller1.abort()
  const result1 = await bridge.ui.confirm('标题', '内容', { signal: controller1.signal })
  assert.equal(result1, false)
  assert.equal(events.length, 0)

  // 2. 挂起中触发 abort 立即完成并返回 fallback
  const controller2 = new AbortController()
  const resultPromise2 = bridge.ui.select('选择', ['A', 'B'], { signal: controller2.signal })
  assert.equal(events.length, 1)
  controller2.abort()
  assert.equal(await resultPromise2, undefined)
})

test('ExtensionUiBridge.clear 会取消所有挂起弹窗', async () => {
  const events: PiExtensionEvent[] = []
  const bridge = new ExtensionUiBridge((event) => events.push(event))

  const p1 = bridge.ui.confirm('C1', 'M1')
  const p2 = bridge.ui.input('I1', 'P1')
  assert.equal(events.length, 2)

  bridge.clear()
  assert.equal(await p1, false)
  assert.equal(await p2, undefined)

  // 对已清空的弹窗响应应报错
  const req = events[0]
  if (req.type === 'extension_ui_request') {
    assert.throws(() => bridge.respond(req.id, { confirmed: true }), /扩展交互已取消或超时/)
  }
})

test('ExtensionUiBridge 通知与状态方法直接派发对应事件', () => {
  const events: PiExtensionEvent[] = []
  const bridge = new ExtensionUiBridge((event) => events.push(event))

  bridge.ui.notify('构建成功', 'info')
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'extension_ui_request')
  if (events[0].type === 'extension_ui_request' && events[0].method === 'notify') {
    assert.equal(events[0].message, '构建成功')
    assert.equal(events[0].notifyType, 'info')
  }

  bridge.ui.setStatus('git-branch', 'feature/sdk')
  assert.equal(events.length, 2)
  if (events[1].type === 'extension_ui_request' && events[1].method === 'setStatus') {
    assert.equal(events[1].statusKey, 'git-branch')
    assert.equal(events[1].statusText, 'feature/sdk')
  }

  bridge.ui.setTitle('新会话名称')
  assert.equal(events.length, 3)
  if (events[2].type === 'extension_ui_request' && events[2].method === 'setTitle') {
    assert.equal(events[2].title, '新会话名称')
  }
})
