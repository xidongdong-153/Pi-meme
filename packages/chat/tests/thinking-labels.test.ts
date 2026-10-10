import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearThinkingLabelCache, getThinkingLabel, PLAYFUL_THINKING_LABELS } from '../src/ui/model/thinking-labels'

test('PLAYFUL_THINKING_LABELS 包含坏点子生成中且全为纯文字非空文案', () => {
  assert.ok(PLAYFUL_THINKING_LABELS.includes('坏点子生成中...'))
  assert.ok(PLAYFUL_THINKING_LABELS.length >= 5)

  for (const label of PLAYFUL_THINKING_LABELS) {
    assert.ok(typeof label === 'string' && label.length > 0)
    // 规则：禁止写入任何 emoji
    assert.doesNotMatch(label, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u)
  }
})

test('getThinkingLabel 针对同一 seedKey 返回稳定文案', () => {
  clearThinkingLabelCache()
  const first = getThinkingLabel('turn-1-thinking')
  const second = getThinkingLabel('turn-1-thinking')
  assert.equal(first, second)
  assert.ok(PLAYFUL_THINKING_LABELS.includes(first as (typeof PLAYFUL_THINKING_LABELS)[number]))
})

test('clearThinkingLabelCache 可正常重置缓存', () => {
  clearThinkingLabelCache()
  const val = getThinkingLabel('turn-abc')
  assert.ok(val)
  clearThinkingLabelCache()
})
