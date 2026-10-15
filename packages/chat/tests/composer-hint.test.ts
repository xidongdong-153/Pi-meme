import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleComposerHint } from '../src/ui/composer/composer-hint'
import { applyEvent, emptyChat, fromSnapshot } from '../src/ui/model/state'
import { sessionState } from '../../../tests/fixtures/messages.mjs'

const idle = {
  hint: '把这次改动提交，写好说明',
  draft: '',
  skills: 0,
  attachments: 0,
  running: false,
  paused: false,
  queued: false,
  editing: false,
}

test('草稿被删空后提示还在，运行中或主动关掉才不显示', () => {
  assert.equal(visibleComposerHint(idle), idle.hint)
  assert.equal(visibleComposerHint({ ...idle, draft: '把这次改动提交，写好说明' }), undefined)
  assert.equal(visibleComposerHint({ ...idle, draft: '' }), idle.hint)
  assert.equal(visibleComposerHint({ ...idle, running: true }), undefined)
  assert.equal(visibleComposerHint({ ...idle, queued: true }), undefined)
  assert.equal(visibleComposerHint({ ...idle, dismissed: idle.hint }), undefined)
})

test('提示事件写入状态，下一轮开始时清掉，快照可以恢复', () => {
  let state = applyEvent(emptyChat, { type: 'composer_hint', text: '跑一下相关测试' })
  assert.equal(state.composerHint, '跑一下相关测试')
  state = applyEvent(state, { type: 'agent_start' })
  assert.equal(state.composerHint, undefined)
  state = fromSnapshot({
    connection: { generation: 1, cwd: '/', status: 'ready' },
    state: { ...sessionState(), mode: 'default', composerHint: '把这次改动提交，写好说明' },
    messages: [],
    models: [],
  })
  assert.equal(state.composerHint, '把这次改动提交，写好说明')
  assert.equal(state.running, false)
})
