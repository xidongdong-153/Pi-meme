import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PiMessage, PiSessionEntries, PiBranchEntry } from '@pi-meme/contracts/pi'
import { messageVersions } from '../src/ui/model/message-versions'
import { userMessage } from '../../../tests/fixtures/messages.mjs'

/** 编辑第一轮后的真实树：A1' 与 A1 同级，旧版本分支保留完整的两轮对话。 */
function entries(leafId: string): PiSessionEntries {
  const nodes: PiBranchEntry[] = [
    { id: 'system', parentId: null, timestamp: 't0', type: 'message', role: 'system' },
    { id: 'A1', parentId: 'system', timestamp: 't1', type: 'message', role: 'user', messageTimestamp: 100 },
    { id: 'B1', parentId: 'A1', timestamp: 't2', type: 'message', role: 'assistant' },
    { id: 'A2', parentId: 'B1', timestamp: 't3', type: 'message', role: 'user', messageTimestamp: 300 },
    { id: 'B2', parentId: 'A2', timestamp: 't4', type: 'message', role: 'assistant' },
    { id: 'A1e', parentId: 'system', timestamp: 't5', type: 'message', role: 'user', messageTimestamp: 500 },
    { id: 'B1e', parentId: 'A1e', timestamp: 't6', type: 'message', role: 'assistant' },
  ]
  return { entries: nodes, leafId }
}

const originalFirst: PiMessage = userMessage('第一轮', 100)

test('编辑后停留新版本分支时选中 2/2，旧版本恢复点为 B2', () => {
  const versions = messageVersions(entries('B1e'), originalFirst)
  assert.equal(versions.length, 2)
  assert.equal(versions[0].selected, false)
  assert.equal(versions[0].targetEntryId, 'B2')
  assert.equal(versions[1].selected, true)
  assert.equal(versions[1].targetEntryId, 'B1e')
})

test('切回旧版本后选中 1/2，新版本恢复点为 B1e', () => {
  const versions = messageVersions(entries('B2'), originalFirst)
  assert.equal(versions.length, 2)
  assert.equal(versions[0].selected, true)
  assert.equal(versions[0].targetEntryId, 'B2')
  assert.equal(versions[1].selected, false)
  assert.equal(versions[1].targetEntryId, 'B1e')
})
