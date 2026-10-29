import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityGroup } from '../src/ui/conversation/activity-group'
import { groupConversationTurns } from '../src/ui/model/conversation-turns'
import { applyEvent, fromSnapshot } from '../src/ui/model/state'
import { parseToolMeta } from '../src/ui/model/tool-details'
import { runningActivityLabel } from '../src/ui/model/activity-summary'
import { assistantMessage, userMessage, sessionState } from '../../../tests/fixtures/messages.mjs'

test('提问工具在消息流展示待答和完成文案', () => {
  const item = { id: 'question', name: 'request_user_input', status: 'running' as const }
  assert.equal(runningActivityLabel([item]), '等待你的回答…')
  assert.equal(parseToolMeta({ ...item, status: 'success' }).summary, '已向用户提问')
})

test('缺少工具结果的历史提问不显示等待，当前提问及下一轮分别使用本轮状态', () => {
  const state = fromSnapshot({
    connection: { generation: 1, cwd: '/', status: 'ready' },
    state: { ...sessionState(), mode: 'default' },
    messages: [
      userMessage('第一轮提问', 1000),
      assistantMessage([{ type: 'toolCall', id: 'question', name: 'request_user_input', arguments: {} }], 1100),
    ],
    models: [],
  })
  const renderTurns = (chat: typeof state) =>
    groupConversationTurns(chat.messages, chat.live, chat.tools, chat.running)
      .filter((turn) => turn.type === 'assistant_turn')
      .map((turn) =>
        renderToStaticMarkup(
          createElement(ActivityGroup, {
            items: turn.activities,
            isLive: turn.isLive,
            durationMs: turn.durationMs,
            startedAt: turn.startedAt,
          }),
        ),
      )

  const history = renderTurns(state)[0]!
  assert.match(history, /已结束/)
  assert.match(history, /已向你提问/)
  assert.doesNotMatch(history, /等待你的回答/)
  assert.equal(state.tools.question?.status, 'running')

  const active = applyEvent(state, { type: 'agent_start' })
  assert.match(renderTurns(active)[0]!, /等待你的回答/)
  const settled = renderTurns(applyEvent(active, { type: 'agent_settled' }))[0]!
  assert.match(settled, /已向你提问/)
  assert.doesNotMatch(settled, /等待你的回答/)

  const next = applyEvent(applyEvent(active, { type: 'message_end', message: userMessage('第二轮提问', 2000) }), {
    type: 'message_end',
    message: assistantMessage(
      [{ type: 'toolCall', id: 'next-question', name: 'request_user_input', arguments: {} }],
      2100,
    ),
  })
  const turns = renderTurns(next)
  assert.equal(turns.length, 2)
  assert.match(turns[0]!, /已向你提问/)
  assert.doesNotMatch(turns[0]!, /等待你的回答/)
  assert.match(turns[1]!, /等待你的回答/)
})

test('历史工具分组和嵌套工具都不显示运行文案，当前轮次仍保留', () => {
  const items = [
    { id: 'question', name: 'request_user_input', status: 'running' as const },
    {
      id: 'parent',
      name: 'codemode',
      status: 'running' as const,
      children: [{ id: 'child', name: 'request_user_input', status: 'running' as const }],
    },
  ]
  const history = renderToStaticMarkup(createElement(ActivityGroup, { items }))
  assert.match(history, /活动详情：已向你提问/)
  assert.doesNotMatch(history, /等待你的回答|正在执行 codemode/)
  const active = renderToStaticMarkup(createElement(ActivityGroup, { items, isLive: true }))
  assert.match(active, /活动详情：等待你的回答/)
  assert.match(active, /等待你的回答/)
  assert.doesNotMatch(active, /工具详情：codemode/)
})
