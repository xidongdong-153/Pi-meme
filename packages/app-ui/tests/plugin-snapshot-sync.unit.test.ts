import { test } from 'vitest'
import assert from 'node:assert/strict'
import type { Snapshot } from '@pi-meme/contracts/desktop'
import { PluginSnapshotSync } from '../src/plugin-snapshot-sync'

function snapshot(generation: number, sessionKey = 'A') {
  return { connection: { sessionKey }, uiPlugins: [{ id: 'demo', generation }] } as Snapshot
}

test('旧完整快照迟到不能回滚专用刷新提交的新版 UI', () => {
  const sync = new PluginSnapshotSync()
  const full = sync.begin()
  const plugins = sync.begin()
  assert.equal(sync.commit(plugins, snapshot(2), 'A'), true)
  assert.equal(sync.commit(full, snapshot(1), 'A'), false)
})

test('连续插件变化以已提交的较新读取为准', () => {
  const sync = new PluginSnapshotSync()
  const first = sync.begin()
  const second = sync.begin()
  assert.equal(sync.commit(second, snapshot(3), 'A'), true)
  assert.equal(sync.commit(first, snapshot(2), 'A'), false)
})

test('切换会话后的旧贡献结果不能覆盖选择快照', () => {
  const sync = new PluginSnapshotSync()
  const old = sync.begin()
  const selection = sync.begin()
  assert.equal(sync.commit(selection, snapshot(1, 'B'), 'B'), true)
  assert.equal(sync.commit(old, snapshot(3), 'B'), false)
  assert.equal(sync.commit(sync.begin(), snapshot(4), 'B'), false)
})
