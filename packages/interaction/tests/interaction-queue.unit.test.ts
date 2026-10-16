import assert from 'node:assert/strict'
import { test } from 'vitest'
import { InteractionQueue, composingKey, interactionKey } from '../src/ui/interaction-queue'
import type { PendingInteraction } from '@pi-meme/contracts/collaboration'

const request: PendingInteraction['request'] = {
  type: 'extension_ui_request',
  id: 'same-id',
  method: 'input',
  title: '输入',
}
function context(name: string) {
  return {
    sessionKey: `${name}-session`,
    executionGeneration: 1,
    source: { agentId: name, name, rootSessionKey: 'root-session' },
  }
}
test('相同request id按来源与执行代次隔离，回答绑定创建请求的child session', () => {
  const queue = new InteractionQueue()
  queue.receive(request, context('first'))
  queue.receive(request, context('second'))
  queue.receive(request, context('first'))
  assert.equal(queue.all.length, 2)
  const id = interactionKey('first-session', 1, request.id)
  assert.equal(queue.get(id)?.sessionKey, 'first-session')
  assert.equal(queue.get(id)?.requestId, 'same-id')
  queue.receive({ type: 'extension_ui_closed', id: 'same-id', reason: 'answered' }, context('first'))
  assert.equal(queue.all.length, 1)
  assert.equal(queue.all[0].sessionKey, 'second-session')
})
test('切根不取消待答请求，重连快照恢复当前tree并清除已回答项', () => {
  const queue = new InteractionQueue()
  queue.receive(request, context('first'))
  queue.restore('other-root', [])
  assert.equal(queue.all.length, 1)
  queue.restore('root-session', [{ ...context('second'), request }])
  assert.deepEqual(
    queue.all.map((entry) => entry.sessionKey),
    ['second-session'],
  )
  queue.restore('root-session', [])
  assert.equal(queue.all.length, 0)
})
test('输入法composition与key229不提交回答', () => {
  assert.equal(composingKey({ isComposing: true }), true)
  assert.equal(composingKey({ keyCode: 229 }), true)
  assert.equal(composingKey({ keyCode: 13, isComposing: false }), false)
})

test('多题请求按来源排队，切会话后快照恢复，旧代次关闭不移除新请求', () => {
  const questions: PendingInteraction['request'] = {
    type: 'extension_ui_request',
    id: 'same-id',
    method: 'questions',
    questions: [{ id: 'language', question: '使用什么语言？', options: [{ label: '中文' }, { label: '英文' }] }],
  }
  const queue = new InteractionQueue()
  queue.receive(questions, context('first'))
  queue.receive(questions, context('second'))
  assert.equal(queue.all.length, 2)
  queue.restore('other-root', [])
  assert.equal(queue.all.length, 2)
  queue.restore('root-session', [{ ...context('first'), executionGeneration: 2, request: questions }])
  assert.equal(queue.all.length, 1)
  assert.equal(queue.all[0].executionGeneration, 2)
  queue.receive({ type: 'extension_ui_closed', id: questions.id, reason: 'answered' }, context('first'))
  assert.equal(queue.all.length, 1)
  queue.receive({ type: 'extension_ui_timeout', id: questions.id }, { ...context('first'), executionGeneration: 2 })
  assert.equal(queue.all.length, 0)
})
