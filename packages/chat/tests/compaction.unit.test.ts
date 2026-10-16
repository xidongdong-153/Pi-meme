import assert from 'node:assert/strict'
import { test } from 'vitest'
import { parseCompactionSummary } from '../src/ui/model/compaction-parser'
import { groupConversationTurns } from '../src/ui/model/conversation-turns'
import { applyEvent, emptyChat, fromSnapshot } from '../src/ui/model/state'
import type { PiMessage } from '@pi-meme/contracts/pi'
import type { Snapshot } from '@pi-meme/contracts/desktop'
import { assistantMessage, sessionState, userMessage } from '../../../tests/fixtures/messages.mjs'

test('parseCompactionSummary 正确解析 Pi 标准结构化摘要、进展与文件列表', () => {
  const sample = `## Goal
实现上下文压缩渲染优化

## Constraints & Preferences
- 遵守 TypeScript 严格模式
- 手术式改动

## Progress
### Done
- [x] 更新 contracts 与 runtime 事件
- [x] 添加 compaction turn

### In Progress
- [ ] 编写前端卡片组件

## Key Decisions
- **分段渲染**: 默认半展开核心目标与进展，其余收起

## Next Steps
1. 跑通单测与 quality gate

<read-files>
packages/chat/src/ui/conversation/conversation.tsx
packages/contracts/src/pi.ts
</read-files>

<modified-files>
packages/chat/src/ui/model/types.ts
</modified-files>`

  const parsed = parseCompactionSummary(sample)
  assert.equal(parsed.isStructured, true)
  assert.ok(parsed.goal?.includes('实现上下文压缩渲染优化'))
  assert.ok(parsed.progress?.includes('编写前端卡片组件'))
  assert.ok(parsed.detailsMarkdown?.includes('Constraints & Preferences'))
  assert.ok(parsed.detailsMarkdown?.includes('Key Decisions'))
  assert.ok(parsed.detailsMarkdown?.includes('Next Steps'))
  assert.deepEqual(parsed.readFiles, [
    'packages/chat/src/ui/conversation/conversation.tsx',
    'packages/contracts/src/pi.ts',
  ])
  assert.deepEqual(parsed.modifiedFiles, ['packages/chat/src/ui/model/types.ts'])
})

test('parseCompactionSummary 兼容非结构化与简短摘要', () => {
  const unstructured = '用户要求快速总结前文讨论内容，主要聚焦在前端样式与布局调整。'
  const parsed = parseCompactionSummary(unstructured)
  assert.equal(parsed.isStructured, false)
  assert.equal(parsed.goal, undefined)
  assert.equal(parsed.progress, undefined)
  assert.equal(parsed.detailsMarkdown, unstructured)
  assert.deepEqual(parsed.readFiles, [])
  assert.deepEqual(parsed.modifiedFiles, [])
})

test('groupConversationTurns 将 compactionSummary 与 branchSummary 聚合成独立的 compaction turn', () => {
  const messages: PiMessage[] = [
    {
      role: 'compactionSummary',
      summary: '## Goal\n压缩历史目标\n\n## Progress\n已完成前期探索',
      tokensBefore: 45000,
      timestamp: 1000,
    },
    userMessage('请继续下一步', 1010),
    assistantMessage([{ type: 'text', text: '好的，我们开始执行。' }], 1020),
    {
      role: 'branchSummary',
      summary: '## Goal\n分支摘要目标',
      fromId: 'entry-old',
      timestamp: 1030,
    },
  ]

  const turns = groupConversationTurns(messages, null, {}, false)
  assert.equal(turns.length, 4)

  assert.equal(turns[0]?.type, 'compaction')
  if (turns[0]?.type === 'compaction') {
    assert.equal(turns[0].kind, 'compaction')
    assert.equal(turns[0].tokensBefore, 45000)
    assert.ok(turns[0].summary.includes('压缩历史目标'))
  }

  assert.equal(turns[1]?.type, 'user')
  assert.equal(turns[2]?.type, 'assistant_turn')

  assert.equal(turns[3]?.type, 'compaction')
  if (turns[3]?.type === 'compaction') {
    assert.equal(turns[3].kind, 'branch_summary')
  }
})

test('groupConversationTurns 将最新发生的 compactionSummary 排在最后一条 Pi 消息下方而非顶部', () => {
  // Pi 的 get_messages 默认将 compactionSummary 放在数组头部 (index 0)
  // 但其 timestamp 是在压缩发生时生成的 (晚于用户与助手消息)
  const messages: PiMessage[] = [
    {
      role: 'compactionSummary',
      summary: '## Goal\n最新压缩摘要',
      tokensBefore: 80000,
      timestamp: 2000, // 晚于 1000 和 1010
    },
    userMessage('写一段代码', 1000),
    assistantMessage([{ type: 'text', text: '这是代码实现' }], 1010),
  ]

  const turns = groupConversationTurns(messages, null, {}, false)
  assert.equal(turns.length, 3)
  assert.equal(turns[0]?.type, 'user')
  assert.equal(turns[1]?.type, 'assistant_turn')
  assert.equal(turns[2]?.type, 'compaction')
  if (turns[2]?.type === 'compaction') {
    assert.equal(turns[2].tokensBefore, 80000)
    assert.ok(turns[2].summary.includes('最新压缩摘要'))
  }
})

test('groupConversationTurns 按时间戳把压缩摘要插到保留消息之后、压缩后新消息之前', () => {
  // Pi 真实上下文：compactionSummary 置顶，随后是 firstKeptEntryId 起的保留消息，
  // 再之后是压缩后继续产生的消息。时间戳排序应还原为：保留消息 -> 压缩摘要 -> 新消息。
  const messages: PiMessage[] = [
    {
      role: 'compactionSummary',
      summary: '## Goal\n压缩点',
      tokensBefore: 60000,
      timestamp: 2000,
    },
    userMessage('压缩前的用户消息', 1000),
    assistantMessage([{ type: 'text', text: '压缩前的回复' }], 1010),
    userMessage('压缩后的用户消息', 3000),
    assistantMessage([{ type: 'text', text: '压缩后的回复' }], 3010),
  ]

  const turns = groupConversationTurns(messages, null, {}, false)
  assert.deepEqual(
    turns.map((turn) => turn.type),
    ['user', 'assistant_turn', 'compaction', 'user', 'assistant_turn'],
  )
})

test('state 处理 compaction_start 与 compaction_end 事件并维护状态', () => {
  let state = emptyChat
  assert.equal(state.compacting, null)
  assert.equal(state.running, false)

  state = applyEvent(state, { type: 'compaction_start', reason: 'threshold' })
  assert.equal(state.running, true)
  assert.deepEqual(state.compacting, { active: true })

  state = applyEvent(state, {
    type: 'compaction_end',
    reason: 'threshold',
    result: {
      summary: '摘要',
      firstKeptEntryId: 'id1',
      tokensBefore: 1000,
    },
    aborted: false,
    willRetry: false,
  })
  assert.equal(state.compacting, null)
})

test('fromSnapshot 正确恢复 isCompacting 状态', () => {
  const fakeSnapshot: Snapshot = {
    connection: { generation: 1, status: 'ready', cwd: '/test' },
    state: { ...sessionState({ isCompacting: true }), mode: 'default' },
    messages: [],
    models: [],
  }

  const restored = fromSnapshot(fakeSnapshot)
  assert.equal(restored.running, true)
  assert.deepEqual(restored.compacting, { active: true })
})
