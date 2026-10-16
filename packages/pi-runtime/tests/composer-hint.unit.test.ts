import assert from 'node:assert/strict'
import { test } from 'vitest'
import { parseComposerHint, summarizeTurn } from '../src/sdk/composer-hint'

test('模型不建议时没有提示', () => {
  assert.equal(parseComposerHint('{"show":false}'), null)
  assert.equal(parseComposerHint('没有下一步'), null)
  assert.equal(parseComposerHint('{"show":true,"text":""}'), null)
  assert.equal(parseComposerHint(`{"show":true,"text":"${'改'.repeat(25)}"}`), null)
})

test('从模型输出里取出一句短提示', () => {
  assert.equal(
    parseComposerHint('```json\n{"show":true,"text":"把这次改动提交，写好说明"}\n```'),
    '把这次改动提交，写好说明',
  )
})

test('没有完整一轮时不请求模型', () => {
  assert.equal(summarizeTurn([{ role: 'assistant', content: [{ type: 'text', text: '好的' }] }]), null)
})

test('摘要带上用户问题、回复、编辑和失败命令', () => {
  const summary = summarizeTurn([
    { role: 'user', content: '把按钮补上' },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', name: 'edit', arguments: { path: 'src/app.tsx' } }],
    },
    { role: 'toolResult', toolName: 'bash', isError: true },
    {
      role: 'assistant',
      content: [{ type: 'text', text: '按钮已经加上' }],
      stopReason: 'stop',
    },
  ])
  assert.ok(summary)
  assert.match(summary, /用户：把按钮补上/)
  assert.match(summary, /助手：按钮已经加上/)
  assert.match(summary, /edit app\.tsx/)
  assert.match(summary, /bash 失败/)
})
