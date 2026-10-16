import assert from 'node:assert/strict'
import { test } from 'vitest'
import { activePathIds, branchEndpoint } from '../src/session-tree'
import type { PiBranchEntry } from '../src/pi'

/** 构造一条用户消息条目。 */
function user(id: string, parentId: string | null, timestamp: string, messageTimestamp: number): PiBranchEntry {
  return { id, parentId, timestamp, type: 'message', role: 'user', messageTimestamp }
}

/** 构造一条 assistant 回复条目。 */
function assistant(id: string, parentId: string | null, timestamp: string): PiBranchEntry {
  return { id, parentId, timestamp, type: 'message', role: 'assistant' }
}

/**
 * 真实复现用的树：
 * system -> A1 -> B1 -> A2 -> B2（原始两轮对话）
 * system -> A1' -> B1'（编辑第一轮后的新版本，A1' 与 A1 同级）
 */
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

test('切回旧版本时分支终点取到完整后续对话的末端 B2 而不是 B1', () => {
  const entries = twoRoundTree()
  // 编辑后当前位于新版本分支（leaf = B1'）
  const endpoint = branchEndpoint(entries, "B1'", 'A1')
  assert.equal(endpoint?.id, 'B2')
  assert.notEqual(endpoint?.id, 'B1')
})

test('切回新版本时分支终点取该版本自己的末端 B1′', () => {
  const entries = twoRoundTree()
  // 当前位于旧版本分支（leaf = B2）
  const endpoint = branchEndpoint(entries, 'B2', "A1'")
  assert.equal(endpoint?.id, "B1'")
})

test('来回切换时优先保留当前活动路径上的分支终点', () => {
  const entries = twoRoundTree()
  assert.equal(branchEndpoint(entries, 'B2', 'A1')?.id, 'B2')
  assert.equal(branchEndpoint(entries, "B1'", "A1'")?.id, "B1'")
})

test('一个版本下存在多个后续分支时选择时间最新的末端节点', () => {
  const entries: PiBranchEntry[] = [
    { id: 'system', parentId: null, timestamp: 't0', type: 'message', role: 'system' },
    user('A1', 'system', 't1', 100),
    assistant('B1a', 'A1', 't2'),
    user('A2a', 'B1a', 't3', 300),
    assistant('B2a', 'A2a', 't4'),
    assistant('B1b', 'A1', 't5'),
    user('A2b', 'B1b', 't6', 600),
    assistant('B2b', 'A2b', 't7'),
  ]
  // 无活动路径信息时取时间最新的末端分支
  assert.equal(branchEndpoint(entries, null, 'A1')?.id, 'B2b')
  // 当前活动路径在较早分支上时保留该分支
  assert.equal(branchEndpoint(entries, 'B2a', 'A1')?.id, 'B2a')
})

test('版本没有回复时分支终点退回该用户消息本身', () => {
  const entries: PiBranchEntry[] = [
    { id: 'system', parentId: null, timestamp: 't0', type: 'message', role: 'system' },
    user('A1', 'system', 't1', 100),
    assistant('B1', 'A1', 't2'),
    user("A1'", 'system', 't3', 300),
  ]
  assert.equal(branchEndpoint(entries, 'B1', "A1'")?.id, "A1'")
})

test('activePathIds 返回从叶子到根的整条路径', () => {
  const ids = activePathIds(twoRoundTree(), 'B2')
  assert.deepEqual([...ids].sort(), ['A1', 'A2', 'B1', 'B2', 'system'])
})
