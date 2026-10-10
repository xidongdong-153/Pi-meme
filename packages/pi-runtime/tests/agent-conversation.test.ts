import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { projectAgentConversation } from '../src/agent-conversation'
import { userMessage } from '../../../tests/fixtures/messages.mjs'

test('继承ID只裁父prefix，当前分支自身任务在压缩和后续轮次后仍完整保留', () => {
  const timestamp = '2026-10-10T00:00:00Z'
  const entries = [
    { type: 'message', id: 'parent', parentId: null, timestamp, message: userMessage('创建3个代理', 1) },
    { type: 'label', id: 'inherited-label', parentId: 'parent', targetId: 'parent', label: '父标签', timestamp },
    { type: 'message', id: 'own', parentId: 'inherited-label', timestamp, message: userMessage('创建3个代理', 1) },
    { type: 'message', id: 'other', parentId: 'own', timestamp, message: userMessage('另一分支', 2) },
    {
      type: 'compaction',
      id: 'compact',
      parentId: 'own',
      timestamp,
      firstKeptEntryId: 'own',
      summary: '任务摘要',
      tokensBefore: 100,
    },
    { type: 'message', id: 'followup', parentId: 'compact', timestamp, message: userMessage('后续任务', 3) },
  ] as unknown as SessionEntry[]
  const own = projectAgentConversation(entries, 'followup', {
    parentAgentId: 'root',
    inheritedLeafId: 'inherited-label',
    inheritedEntryIds: ['parent', 'inherited-label'],
  })
  assert.deepEqual(
    own.messages.flatMap((message) => (message.role === 'user' ? [message.content] : [])),
    [userMessage('创建3个代理', 1).content, userMessage('后续任务', 3).content],
  )
  assert.deepEqual(
    own.sessionEntries.entries.map((entry) => entry.id),
    ['own', 'compact', 'followup'],
  )
  assert.equal(own.sessionEntries.entries[0].parentId, null)
})

test('旧child按原生parentSession与共享ID及重建label恢复；父文件丢失明确拒绝详情', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { inferAgentConversationOrigin } = await import('../src/agent-conversation')
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-old-agent-origin-'))
  const parent = path.join(directory, 'parent.jsonl')
  const child = path.join(directory, 'child.jsonl')
  const timestamp = '2026-10-10T00:00:00Z'
  const inherited = { type: 'message', id: 'shared', parentId: null, timestamp, message: userMessage('父任务', 1) }
  try {
    await writeFile(
      parent,
      [{ type: 'session', version: 3, id: 'parent', cwd: directory, timestamp }, inherited]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    )
    await writeFile(
      child,
      [
        { type: 'session', version: 3, id: 'child', cwd: directory, timestamp, parentSession: parent },
        inherited,
        { type: 'label', id: 'new-label', parentId: 'shared', targetId: 'shared', label: '父标签', timestamp },
        { type: 'message', id: 'own', parentId: 'new-label', timestamp, message: userMessage('父任务', 1) },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    )
    assert.deepEqual(await inferAgentConversationOrigin(child, 'root'), {
      parentAgentId: 'root',
      inheritedLeafId: 'new-label',
      inheritedEntryIds: ['shared', 'new-label'],
    })
    await rm(parent)
    await assert.rejects(inferAgentConversationOrigin(child, 'root'), /父会话文件无法读取.*不能确认继承历史边界/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
