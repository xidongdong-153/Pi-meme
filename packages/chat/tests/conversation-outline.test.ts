import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conversationOutline } from '../src/ui/model/conversation-outline'
import { groupConversationTurns } from '../src/ui/model/conversation-turns'
import type { TurnChunk } from '../src/ui/model/types'
import { assistantMessage, toolResult, userMessage } from '../../../tests/fixtures/messages.mjs'

test('每条用户输入对应后续回复，并保留定位用的轮次下标与唯一键', () => {
  const turns = groupConversationTurns(
    [
      userMessage('第一问', 1000),
      assistantMessage('第一答', 1000),
      userMessage('第二问', 1000),
      assistantMessage('第二答', 1000),
    ],
    null,
    {},
    false,
  )
  const entries = conversationOutline(turns)
  assert.deepEqual(
    entries.map(({ title, preview, turnIndex }) => ({ title, preview, turnIndex })),
    [
      { title: '第一问', preview: '第一答', turnIndex: 0 },
      { title: '第二问', preview: '第二答', turnIndex: 2 },
    ],
  )
  assert.notEqual(entries[0].key, entries[1].key)
  assert.equal(entries[0].key, turns[0].key)
  assert.equal(entries[1].key, turns[2].key)
})

test('状态和压缩只分割回复，索引合并同一输入后的最终文本', () => {
  const turns = groupConversationTurns(
    [
      userMessage('继续任务', 1000),
      assistantMessage('第一阶段', 1500),
      { role: 'compactionSummary', summary: '私有压缩内容', tokensBefore: 100, timestamp: 2200 },
      assistantMessage('第二阶段', 2300),
    ],
    null,
    {},
    false,
    {},
    [{ type: 'agent_status', agentId: 'reviewer', name: '审查', status: '已完成', timestamp: 2000, key: 'status' }],
  )
  assert.deepEqual(conversationOutline(turns), [
    { key: turns[0].key, turnIndex: 0, title: '继续任务', preview: '第一阶段 第二阶段' },
  ])
})

test('技能标题只保留用户可见引用，预览不读取思考、工具结果和子代理正文', () => {
  const turns = groupConversationTurns(
    [
      userMessage('请使用\n <skill name="review" location="/skills/review/SKILL.md">私有技能正文</skill>\t检查', 1000),
      assistantMessage(
        [
          { type: 'thinking', thinking: '私有思考' },
          { type: 'text', text: '过程描述' },
          { type: 'toolCall', id: 'tool', name: 'read', arguments: { path: '私有路径' } },
        ],
        1500,
      ),
      toolResult('tool', '私有工具结果与子代理正文', 1600),
      assistantMessage('**已完成**，参考 [文件](https://example.test/file) 与 `代码`。', 1700),
    ],
    null,
    {
      tool: {
        id: 'tool',
        name: 'read',
        result: '私有工具结果与子代理正文',
        children: [{ id: 'child', name: 'subagent', result: '私有子代理正文', status: 'success' }],
        status: 'success',
      },
    },
    false,
  )
  assert.equal(conversationOutline(turns)[0].title, '请使用 $review 检查')
  assert.equal(conversationOutline(turns)[0].preview, '已完成，参考 文件 与 代码。')
  assert.doesNotMatch(JSON.stringify(conversationOutline(turns)), /私有|过程描述|SKILL\.md|example\.test/)
})

test('图片输入与尚无回复的输入都有可见简述', () => {
  const turns = groupConversationTurns(
    [userMessage([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], 1000), userMessage('  ', 2000)],
    null,
    {},
    false,
  )
  assert.deepEqual(
    conversationOutline(turns).map(({ title, preview }) => ({ title, preview })),
    [
      { title: '图片消息', preview: '暂无回复' },
      { title: '用户消息', preview: '暂无回复' },
    ],
  )
})

test('回复为空时区分流式、错误和图片，正文优先于兜底状态', () => {
  const reply: Extract<TurnChunk, { type: 'assistant_turn' }> = {
    type: 'assistant_turn',
    activities: [],
    finalText: '',
    images: [],
    isLive: true,
    key: 'reply',
  }
  const input: Extract<TurnChunk, { type: 'user' }> = {
    type: 'user',
    message: userMessage('开始', 1000),
    key: 'input',
  }
  assert.equal(conversationOutline([input, reply])[0].preview, '正在回复…')
  assert.equal(conversationOutline([input, { ...reply, errorMessage: '  请求\n失败  ' }])[0].preview, '请求 失败')
  assert.equal(
    conversationOutline([
      input,
      { ...reply, isLive: false, images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
    ])[0].preview,
    '图片回复',
  )
  assert.equal(
    conversationOutline([input, { ...reply, finalText: '已收到', errorMessage: '忽略错误' }])[0].preview,
    '已收到',
  )

  const streaming = groupConversationTurns([input.message], assistantMessage('正在写回复', 1500), {}, true)
  assert.equal(conversationOutline(streaming)[0].preview, '正在写回复')
})

test('标题和预览压平空白并截断，截断不会切开 Unicode 字符，也不改变原始轮次', () => {
  const turns = groupConversationTurns(
    [userMessage(`  ${'字'.repeat(120)}\n`, 1000), assistantMessage(`\n${'𠮷'.repeat(260)}\t`, 2000)],
    null,
    {},
    false,
  )
  const original = structuredClone(turns)
  const entry = conversationOutline(turns)[0]
  assert.equal(Array.from(entry.title).length, 100)
  assert.equal(Array.from(entry.preview).length, 240)
  assert.equal(entry.title, `${'字'.repeat(99)}…`)
  assert.equal(entry.preview, `${'𠮷'.repeat(239)}…`)
  assert.deepEqual(turns, original)
})
