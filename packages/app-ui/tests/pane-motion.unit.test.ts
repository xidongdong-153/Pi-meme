import assert from 'node:assert/strict'
import { test } from 'vitest'
import { paneCollapsePull, resistWidth, settlePane } from '../src/layout/pane-motion'

test('区间内宽度跟手，越界后位移变短', () => {
  assert.equal(resistWidth(240, 200, 420), 240)
  const under = resistWidth(200 - 80, 200, 420)
  assert.ok(under < 200)
  assert.ok(under > 200 - 80)
  const over = resistWidth(420 + 80, 200, 420)
  assert.ok(over > 420)
  assert.ok(over < 420 + 80)
  assert.equal(resistWidth(10, 280, 280), 280)
})

test('松手夹回区间；拉过收起阈值则关闭且不改已保存宽度', () => {
  assert.deepEqual(settlePane(240, 200, 420), { collapse: false, width: 240 })
  assert.deepEqual(settlePane(500, 200, 420), { collapse: false, width: 420 })
  assert.deepEqual(settlePane(200 - paneCollapsePull + 1, 200, 420), { collapse: false, width: 200 })
  assert.deepEqual(settlePane(200 - paneCollapsePull, 200, 420), { collapse: true, width: 200 })
  assert.deepEqual(settlePane(40, 280, 100), { collapse: true, width: 280 })
})
