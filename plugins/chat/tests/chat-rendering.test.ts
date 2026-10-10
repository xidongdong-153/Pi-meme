import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityGroup } from '../src/ui/conversation/activity-group'
import type { PiContent, PiMessage } from '@pi-meme/contracts/pi'
import { groupMessageParts } from '../src/ui/model/message-parts'
import { groupConversationTurns } from '../src/ui/model/conversation-turns'
import { extractDiff, extractImages, formatDetailValue, parseToolMeta } from '../src/ui/model/tool-details'
import { summarizeActivities } from '../src/ui/model/activity-summary'
import { assistantMessage, bashMessage, toolResult, userMessage } from '../../../tests/fixtures/messages.mjs'

test('groupMessageParts 将思考过程与所有工具调用内聚到同一个 activity 组中', () => {
  const parts: PiContent[] = [
    { type: 'thinking', thinking: '正在分析目录结构' },
    { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'src/main.ts' } },
    { type: 'toolCall', id: 'tool-2', name: 'bash', arguments: { command: 'pnpm test' } },
    { type: 'thinking', thinking: '测试完毕，准备修改代码' },
    { type: 'toolCall', id: 'tool-3', name: 'edit', arguments: { path: 'src/main.ts' } },
    { type: 'text', text: '已为您完成代码修改并验证完毕。' },
  ]
  const toolsMap = {
    'tool-1': { id: 'tool-1', name: 'read', status: 'success' as const, result: 'content' },
    'tool-2': { id: 'tool-2', name: 'bash', status: 'success' as const, result: 'passed' },
    'tool-3': { id: 'tool-3', name: 'edit', status: 'success' as const, result: { diff: '@@ -1 +1 @@' } },
  }

  const segments = groupMessageParts(parts, toolsMap, false)
  // 思考与工具调用连续发生时，应当内聚为 1 个 activity 组，后面紧接 1 个 text 组
  assert.equal(segments.length, 2)
  assert.equal(segments[0].type, 'activity')
  if (segments[0].type === 'activity') {
    assert.equal(segments[0].items.length, 5)
    assert.equal(segments[0].items[0].type, 'thinking')
    assert.equal(segments[0].items[1].type, 'tool')
    assert.equal(segments[0].items[2].type, 'tool')
    assert.equal(segments[0].items[3].type, 'thinking')
    assert.equal(segments[0].items[4].type, 'tool')
  }
  assert.equal(segments[1].type, 'text')
  if (segments[1].type === 'text') {
    assert.equal(segments[1].text, '已为您完成代码修改并验证完毕。')
  }
})

test('groupConversationTurns 将同一问答轮次内的多条独立 Assistant 消息、Bash 和思考聚合成单一工作组与最终正文', () => {
  const messages: PiMessage[] = [
    userMessage('1.无需处理 2.删除 3.给出解决方案', 1000),
    assistantMessage([{ type: 'toolCall', id: 'call-1', name: 'edit', arguments: { path: 'a.txt' } }], 1100),
    toolResult('call-1', 'ok', 1200),
    bashMessage('git diff', 'diff content', 1300),
    assistantMessage([{ type: 'toolCall', id: 'call-2', name: 'edit', arguments: { path: 'b.txt' } }], 1400),
    toolResult('call-2', 'ok', 1500),
    bashMessage('pnpm test', 'tests passed', 1600),
    assistantMessage(
      [
        { type: 'thinking', thinking: '梳理完成，准备答复' },
        { type: 'text', text: '三项都处理完了。\n1. AUTH_BOOTSTRAP_ADMIN_EMAIL — 未动' },
      ],
      1700,
    ),
  ]
  const toolsMap = {
    'call-1': { id: 'call-1', name: 'edit', status: 'success' as const, result: 'ok' },
    'call-2': { id: 'call-2', name: 'edit', status: 'success' as const, result: 'ok' },
  }

  const turns = groupConversationTurns(messages, null, toolsMap, false)
  // 必须只生成 2 个顶层卡片：1 个 user，1 个 assistant_turn
  assert.equal(turns.length, 2)
  assert.equal(turns[0].type, 'user')

  const assistantTurn = turns[1]
  assert.equal(assistantTurn.type, 'assistant_turn')
  if (assistantTurn.type === 'assistant_turn') {
    // 包含 2 次 edit + 2 次 bash + 1 次 thinking = 5 次操作全部归入单一 activities
    assert.equal(assistantTurn.activities.length, 5)
    assert.equal(assistantTurn.activities[0].type, 'tool')
    assert.equal(assistantTurn.activities[1].type, 'tool')
    assert.equal(assistantTurn.activities[2].type, 'tool')
    assert.equal(assistantTurn.activities[3].type, 'tool')
    assert.equal(assistantTurn.activities[4].type, 'thinking')

    // 最终正文独立存在
    assert.equal(assistantTurn.finalText, '三项都处理完了。\n1. AUTH_BOOTSTRAP_ADMIN_EMAIL — 未动')
    // 计算耗时 1700 - 1000 = 700ms
    assert.equal(assistantTurn.durationMs, 700)
    assert.equal(assistantTurn.startedAt, 1000)
    // 轮次结束，isLive 为 false（界面默认折叠）
    assert.equal(assistantTurn.isLive, false)
  }
})

test('工具详情解析保留嵌套 Diff、图片和未知工具输出', () => {
  const result = {
    content: [
      { type: 'text', text: '完成' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
    details: { diff: '@@ -1 +1 @@\n-old\n+new' },
  }
  assert.equal(extractDiff(result), result.details.diff)
  assert.deepEqual(extractImages(result), [{ data: 'AAAA', mimeType: 'image/png' }])
  assert.equal(formatDetailValue({ content: [{ type: 'text', text: '自定义输出' }] }), '自定义输出')
  assert.deepEqual(parseToolMeta({ id: 'custom', type: 'tool', name: 'custom-tool', result: {} }), {
    kind: 'generic',
    summary: '已执行 custom-tool',
  })
})

test('活动摘要按实际路径去重，纯模型不需要图标组件', () => {
  const summary = summarizeActivities([
    { id: 'thought', type: 'thinking', thinking: '检查文件' },
    { id: '1', type: 'tool', name: 'read', args: { path: 'src/main.ts' } },
    { id: '2', type: 'tool', name: 'read', args: { path: 'src/main.ts' } },
    { id: '3', type: 'tool', name: 'bash', args: { command: 'pnpm test' } },
  ])
  assert.equal(summary.summary, '读取了 1 个文件 · 执行了 1 条命令')
  assert.equal(summary.kind, 'read')
})

test('只有思考活动时不显示思考过程摘要', () => {
  assert.deepEqual(summarizeActivities([{ id: 'thought', type: 'thinking', thinking: '检查文件' }]), {
    summary: '',
    kind: 'thinking',
  })
})

test('工作过程运行时默认折叠且只显示计时，结束后显示工具统计', () => {
  const items = [
    { id: 'read', type: 'tool' as const, name: 'read', args: { path: 'src/main.ts' }, status: 'success' as const },
    { id: 'thought', type: 'thinking' as const, thinking: '检查文件', status: 'success' as const },
  ]
  const live = renderToStaticMarkup(createElement(ActivityGroup, { items, isLive: true, startedAt: Date.now() }))
  assert.match(live, /aria-expanded="false"/)
  assert.match(live, /工作了 0秒/)
  assert.doesNotMatch(live, /读取了|思考过程|展开所有|工具详情/)

  const completed = renderToStaticMarkup(createElement(ActivityGroup, { items, durationMs: 45000 }))
  assert.match(completed, /aria-expanded="false"/)
  assert.match(completed, /工作了 45秒 · 读取了 1 个文件/)
  assert.doesNotMatch(completed, /思考过程|展开所有|工具详情/)
})

test('用户气泡显示多个内联技能名，不显示技能长正文和路径', async () => {
  const { UserMessageContent } = await import('../src/ui/conversation/user-message-content')
  const text =
    '123 <skill name="typescript" location="/skills/a/SKILL.md">长正文 A</skill> <skill name="review-code" location="/skills/b/SKILL.md">长正文 B</skill> 看看技能'
  const markup = renderToStaticMarkup(createElement(UserMessageContent, { text }))
  assert.match(markup, /技能：typescript/)
  assert.match(markup, /技能：review-code/)
  assert.match(markup, /123|看看技能/)
  assert.doesNotMatch(markup, /长正文 A|长正文 B/)
})

test('ThinkingActivityRow 在运行和完成态均渲染调皮文案，且文案非空', async () => {
  const { ThinkingActivityRow } = await import('../src/ui/conversation/thinking-activity-row')
  const { PLAYFUL_THINKING_LABELS } = await import('../src/ui/model/thinking-labels')

  const runningItem = {
    id: 'thought-run-1',
    type: 'thinking' as const,
    thinking: '正在思考中',
    status: 'running' as const,
  }
  const runningMarkup = renderToStaticMarkup(
    createElement(ThinkingActivityRow, { item: runningItem, open: false, onToggle: () => {} }),
  )
  const hasRunningLabel = PLAYFUL_THINKING_LABELS.some((label) => runningMarkup.includes(label))
  assert.equal(hasRunningLabel, true)

  const completedItem = {
    id: 'thought-done-1',
    type: 'thinking' as const,
    thinking: '已经思考完毕',
    status: 'success' as const,
  }
  const completedMarkup = renderToStaticMarkup(
    createElement(ThinkingActivityRow, { item: completedItem, open: false, onToggle: () => {} }),
  )
  const hasCompletedLabel = PLAYFUL_THINKING_LABELS.some((label) => completedMarkup.includes(label))
  assert.equal(hasCompletedLabel, true)
})

test('ThinkingActivityRow 展开时为无边框无框体设计，不包含复制按钮和思考内容表头', async () => {
  const { ThinkingActivityRow } = await import('../src/ui/conversation/thinking-activity-row')
  const item = {
    id: 'thought-open-1',
    type: 'thinking' as const,
    thinking: '正在分析用户诉求',
    status: 'success' as const,
  }
  const openMarkup = renderToStaticMarkup(createElement(ThinkingActivityRow, { item, open: true, onToggle: () => {} }))
  assert.match(openMarkup, /正在分析用户诉求/)
  assert.doesNotMatch(openMarkup, /复制|思考内容|border-border/)
})
