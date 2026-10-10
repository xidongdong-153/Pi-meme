import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import { SessionActivity } from '../src/ui/session-activity'

function snapshot(): PiSessionsSnapshot {
  return {
    projects: [],
    recents: [],
    pinnedPaths: [],
    activeSessionId: 'A',
    activeSessionPath: '/A.jsonl',
  }
}

test('新会话选择先提交，旧列表晚到仍可更新数据但不能把旧行标成当前', () => {
  const activity = new SessionActivity()
  const pending = snapshot()
  activity.select('runtime:B', 'B')
  const next = activity.apply(pending)
  assert.equal(next.activeSessionId, 'B')
  assert.equal(next.activeSessionPath, 'runtime:B')
  assert.equal(next.projects, pending.projects)
  assert.equal(next.recents, pending.recents)
})

test('首个列表尚未到达时提交的选择不会丢失', () => {
  const activity = new SessionActivity()
  activity.select('/B.jsonl', 'B')
  const first = activity.apply(snapshot())
  assert.equal(first.activeSessionPath, '/B.jsonl')
  assert.equal(first.activeSessionId, 'B')
})

test('尚无客户端选择时使用 Host 标记，显式清空后不恢复旧标记', () => {
  const activity = new SessionActivity()
  const initial = snapshot()
  assert.equal(activity.apply(initial), initial)
  activity.select()
  const cleared = activity.apply(initial)
  assert.equal(cleared.activeSessionId, undefined)
  assert.equal(cleared.activeSessionPath, undefined)
})
