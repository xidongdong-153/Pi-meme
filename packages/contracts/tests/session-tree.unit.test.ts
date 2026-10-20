import assert from 'node:assert/strict'
import { test } from 'vitest'
import { activePathIds } from '../src/session-tree'
import type { PiBranchEntry } from '../src/pi'

/** 构造一条用户消息条目。 */
function user(id: string, parentId: string | null, timestamp: string, messageTimestamp: number): PiBranchEntry {
  return { id, parentId, timestamp, type: 'message', role: 'user', messageTimestamp }
}

/** 构造一条 assistant 回复条目。 */
function assistant(id: string, parentId: string | null, timestamp: string): PiBranchEntry {
  return { id, parentId, timestamp, type: 'message', role: 'assistant' }
}

/** 包含两轮对话及另一条历史路径的原生会话树。 */
function twoRoundTree(): PiBranchEntry[] {
  return [
    { id: 'system', parentId: null, timestamp: 't0', type: 'message', role: 'system' },
    user('A1', 'system', 't1', 100),
    assistant('B1', 'A1', 't2'),
    user('A2', 'B1', 't3', 300),
    assistant('B2', 'A2', 't4'),
    user("A1'", 'system', 't5', 500),
    assistant("B1'", "A1'", 't6'),
  ]
}

test('activePathIds 返回从叶子到根的整条路径', () => {
  const ids = activePathIds(twoRoundTree(), 'B2')
  assert.deepEqual([...ids].sort(), ['A1', 'A2', 'B1', 'B2', 'system'])
})
