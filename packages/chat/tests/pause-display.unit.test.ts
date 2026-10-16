import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { groupConversationTurns } from '../src/ui/model/conversation-turns'
import { ActivityGroup } from '../src/ui/conversation/activity-group'
import { ThinkingActivityRow } from '../src/ui/conversation/thinking-activity-row'
import { ToolActivityRow } from '../src/ui/conversation/tool-activity-row'
import { AssistantTurnView } from '../src/ui/conversation/assistant-turn'
import { activeDuration } from '../src/ui/model/active-duration'
import { applyEvent, emptyChat, fromSnapshot } from '../src/ui/model/state'
import { assistantMessage, userMessage, sessionState } from '../../../tests/fixtures/messages.mjs'

const pauses = [{ startedAt: 4000, endedAt: 7000 }, { startedAt: 10000 }]

test('暂停时长只扣本轮重叠区间，开放暂停冻结，恢复后继续累计', () => {
  assert.equal(activeDuration(1000, 3000, pauses), 2000)
  assert.equal(activeDuration(1000, 9000, pauses), 5000)
  assert.equal(activeDuration(8000, 12000, pauses), 2000)
  assert.equal(activeDuration(8000, 18000, pauses), 2000)
  assert.equal(activeDuration(8000, 18000, [{ startedAt: 10000, endedAt: 15000 }]), 5000)
  assert.equal(activeDuration(5000, 8000, pauses), 1000)
  assert.equal(
    activeDuration(1000, 8000, [
      { startedAt: 3000, endedAt: 6000 },
      { startedAt: 5000, endedAt: 7000 },
    ]),
    3000,
  )
})

test('快照和事件恢复权威暂停区间，旧修订不能覆盖，队列暂停不等于工作暂停', () => {
  const snapshot = {
    connection: { generation: 1, cwd: '/', status: 'ready' as const },
    state: { ...sessionState(), mode: 'default' as const, isPaused: true, pauseRevision: 2, pauseIntervals: pauses },
    messages: [],
    models: [],
  }
  const restored = fromSnapshot(snapshot)
  assert.deepEqual(restored.pauseIntervals, pauses)
  assert.equal(restored.paused, true)
  assert.equal(
    applyEvent(restored, {
      type: 'pause_update',
      revision: 1,
      isPaused: false,
      queuePaused: false,
      pauseIntervals: [],
    }),
    restored,
  )
  const queued = applyEvent(emptyChat, {
    type: 'pause_update',
    revision: 1,
    isPaused: false,
    queuePaused: true,
    pauseIntervals: [],
  })
  assert.equal(queued.paused, false)
  assert.equal(queued.queuePaused, true)
})

test('工作过程和空回复仅显示用时且没有转圈，暂停后计时冻结', () => {
  const items = [{ id: 'thinking', type: 'thinking' as const, thinking: '分析', status: 'running' as const }]
  const render = (isPaused: boolean) =>
    renderToStaticMarkup(
      createElement(ActivityGroup, {
        items,
        isLive: true,
        isPaused,
        startedAt: 1000,
        pauseIntervals: [{ startedAt: 4000 }],
      }),
    )
  const paused = render(true)
  assert.doesNotMatch(paused, /lucide-loader|lucide-sparkles|animate-spin/)
  assert.match(paused, /lucide-chevron-down/)
  assert.match(paused, /用时 3秒/)
  assert.doesNotMatch(render(false), /animate-spin|lucide-loader/)
  const thinking = renderToStaticMarkup(
    createElement(ThinkingActivityRow, { item: items[0], open: true, onToggle: () => {}, isPaused: true }),
  )
  assert.doesNotMatch(thinking, /animate-spin|lucide-sparkles/)
  const tool = renderToStaticMarkup(
    createElement(ToolActivityRow, {
      item: {
        id: 'parent',
        name: 'codemode',
        status: 'running',
        children: [{ id: 'child', name: 'read', status: 'running' }],
      },
      open: true,
      onToggle: () => {},
      isPaused: true,
    }),
  )
  assert.doesNotMatch(tool, /animate-spin|lucide-wrench|lucide-book-open/)
  assert.match(tool, /工具详情：read/)
  const history = renderToStaticMarkup(
    createElement(ActivityGroup, {
      items: [{ ...items[0]!, status: 'success' }],
      durationMs: 8000,
      startedAt: 1000,
      pauseIntervals: pauses,
    }),
  )
  assert.match(history, /lucide-sparkles/)
  assert.match(history, /用时 5秒/)
  const placeholder = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(AssistantTurnView, {
        turn: { type: 'assistant_turn', activities: [], images: [], finalText: '', isLive: true, key: 'live' },
        isPaused: true,
      }),
    ),
  )
  assert.match(placeholder, /已暂停/)
  assert.doesNotMatch(placeholder, /animate-spin|animate-pulse|Pi 正在分析/)
})

test('完成后用实际运行终点计时，刷新保留暂停扣减且后续暂停不影响前轮', () => {
  const messages = [
    userMessage('第一轮', 1000),
    assistantMessage([{ type: 'thinking', thinking: '分析' }], 1200),
    userMessage('第二轮', 12000),
    assistantMessage('答复', 12100),
  ]
  const runs = [
    { startedAt: 1100, endedAt: 11000 },
    { startedAt: 12000, endedAt: 15000 },
  ]
  const state = fromSnapshot({
    connection: { generation: 1, cwd: '/', status: 'ready' },
    state: {
      ...sessionState(),
      mode: 'default' as const,
      runIntervals: runs,
      pauseIntervals: [
        { startedAt: 4000, endedAt: 8000 },
        { startedAt: 13000, endedAt: 14000 },
      ],
    },
    messages,
    models: [],
  })
  const turns = groupConversationTurns(state.messages, null, state.tools, false, {}, [], state.runIntervals)
  const first = turns.find((turn) => turn.type === 'assistant_turn')
  assert.ok(first?.type === 'assistant_turn')
  assert.equal(first.durationMs, 10000)
  assert.equal(activeDuration(first.startedAt!, first.startedAt! + first.durationMs!, state.pauseIntervals), 6000)
  const markup = renderToStaticMarkup(
    createElement(ActivityGroup, {
      items: first.activities,
      startedAt: first.startedAt,
      durationMs: first.durationMs,
      pauseIntervals: state.pauseIntervals,
    }),
  )
  assert.match(markup, /用时 6秒/)
})

test('未记录历史耗时显示已结束，短时运行和完成分别显示处理中与不足1秒', () => {
  vi.spyOn(Date, 'now').mockImplementation(() => 20000)
  const render = (props: Parameters<typeof ActivityGroup>[0]) =>
    renderToStaticMarkup(createElement(ActivityGroup, props))
  assert.match(render({ items: [] }), /已结束/)
  assert.match(render({ items: [], durationMs: 500 }), /用时不足1秒/)
  assert.match(render({ items: [], durationMs: 0 }), /用时不足1秒/)
  assert.match(render({ items: [], isLive: true, startedAt: 20000 }), /处理中/)
  assert.match(render({ items: [], isLive: true, isPaused: true, startedAt: 20000 }), /已暂停/)

  const state = fromSnapshot({
    connection: { generation: 1, cwd: '/', status: 'ready' },
    state: { ...sessionState(), mode: 'default' },
    messages: [
      userMessage('历史提问', 1000),
      assistantMessage([{ type: 'toolCall', id: 'question', name: 'request_user_input', arguments: {} }], 1026),
    ],
    models: [],
  })
  const turn = groupConversationTurns(state.messages, null, state.tools, false).find(
    (chunk) => chunk.type === 'assistant_turn',
  )
  assert.ok(turn?.type === 'assistant_turn')
  assert.equal(turn.durationMs, undefined)
  assert.match(
    render({ items: turn.activities, isLive: turn.isLive, startedAt: turn.startedAt, durationMs: turn.durationMs }),
    /已结束/,
  )
})

test('历史工具缺少结束结果时用时保持固定，下一轮继续独立计时', () => {
  let now = 20000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const state = fromSnapshot({
    connection: { generation: 1, cwd: '/', status: 'ready' },
    state: { ...sessionState(), mode: 'default', runIntervals: [{ startedAt: 1000, endedAt: 6000 }] },
    messages: [
      userMessage('第一轮提问', 1000),
      assistantMessage([{ type: 'toolCall', id: 'question', name: 'request_user_input', arguments: {} }], 1200),
    ],
    models: [],
  })
  const renderTurns = (chat: typeof state) =>
    groupConversationTurns(chat.messages, chat.live, chat.tools, chat.running, {}, [], chat.runIntervals)
      .filter((turn) => turn.type === 'assistant_turn')
      .map((turn) =>
        renderToStaticMarkup(
          createElement(ActivityGroup, {
            items: turn.activities,
            isLive: turn.isLive,
            startedAt: turn.startedAt,
            durationMs: turn.durationMs,
          }),
        ),
      )

  assert.equal(state.running, false)
  assert.equal(state.tools.question?.status, 'running')
  assert.match(renderTurns(state)[0]!, /用时 5秒/)
  now = 30000
  assert.match(renderTurns(state)[0]!, /用时 5秒/)

  const next = applyEvent(applyEvent(state, { type: 'message_end', message: userMessage('第二轮', 25000) }), {
    type: 'agent_start',
    runIntervals: [{ startedAt: 25000 }],
  })
  const running = renderTurns(next)
  assert.equal(running.length, 2)
  assert.match(running[0]!, /用时 5秒/)
  assert.match(running[1]!, /用时 5秒/)
  now = 40000
  const later = renderTurns(next)
  assert.match(later[0]!, /用时 5秒/)
  assert.match(later[1]!, /用时 15秒/)
})

test('相邻运行共用边界时间时选本轮运行，同一用户回合多次唤醒取最后结束', () => {
  const messages = [
    userMessage('第一轮', 1000),
    assistantMessage('第一轮回复', 1100),
    userMessage('第二轮', 4000),
    assistantMessage([{ type: 'thinking', thinking: '思考' }], 4100),
    assistantMessage('唤醒后结果', 7000),
  ]
  const runs = [
    { startedAt: 1000, endedAt: 4000 },
    { startedAt: 4000, endedAt: 6000 },
    { startedAt: 8000, endedAt: 10000 },
  ]
  const turns = groupConversationTurns(messages, null, {}, false, {}, [], runs).filter(
    (turn) => turn.type === 'assistant_turn',
  )
  assert.equal(turns[0]?.durationMs, 3000)
  assert.equal(turns[1]?.startedAt, 4000)
  assert.equal(turns[1]?.durationMs, 6000)
  const firstRunOnly = groupConversationTurns(messages.slice(0, 4), null, {}, false, {}, [], runs.slice(0, 2)).filter(
    (turn) => turn.type === 'assistant_turn',
  )
  assert.equal(firstRunOnly[1]?.durationMs, 2000)
})

test('快照回放较旧agent_start不能重开已完成运行或丢失后续运行', () => {
  const intervals = [
    { startedAt: 1000, endedAt: 4000 },
    { startedAt: 5000, endedAt: 9000 },
  ]
  const state = { ...emptyChat, runIntervals: intervals }
  const replayed = applyEvent(state, { type: 'agent_start', runIntervals: [{ startedAt: 1000 }] })
  assert.deepEqual(replayed.runIntervals, intervals)
})
