import assert from 'node:assert/strict'
import { test } from 'vitest'
import { SessionSelection } from '../src/session/session-selection'
import { SnapshotSync } from '../src/session/snapshot-sync'
import type { Connection, DesktopEvent } from '@pi-meme/contracts/desktop'

test('后一次选择替代前一次，旧请求完成不能清空新事务', () => {
  const selection = new SessionSelection()
  const first = selection.begin('first')
  const second = selection.begin('second')
  selection.finish(first)
  assert.equal(selection.owns(first), false)
  assert.equal(selection.owns(second), true)
  selection.finish(second)
  assert.equal(selection.current, null)
  const third = selection.begin('third')
  selection.cancel()
  assert.equal(selection.owns(third), false)
})

test('快照只缓冲所属会话和代次，旧读取完成不丢弃新读取', () => {
  const sync = new SnapshotSync()
  const connection: Connection = { generation: 1, sessionKey: 'first', cwd: '/first', status: 'ready' }
  const first = sync.begin(connection)
  const event: DesktopEvent = { generation: 1, sessionKey: 'first', sequence: 1, event: { type: 'agent_start' } }
  sync.receive(event)
  sync.receive({ ...event, generation: 0 })
  sync.receive({ ...event, sessionKey: 'second' })
  assert.deepEqual(first.events, [event])
  const second = sync.begin(connection)
  sync.finish(first)
  assert.equal(sync.owns(first, connection), false)
  assert.equal(sync.owns(second, connection), true)
  assert.equal(sync.owns(second, { ...connection, generation: 2 }), false)
  sync.cancel()
  assert.equal(sync.owns(second, connection), false)
})
