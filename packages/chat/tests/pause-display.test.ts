import assert from 'node:assert/strict'
import { test } from 'node:test'
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

test('暂停工作过程和空回复隐藏图标，恢复显示转圈，历史工作保留图标', () => {
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
  assert.match(paused, /工作了 3秒/)
  assert.match(render(false), /animate-spin/)
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
  assert.match(history, /工作了 5秒/)
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
  assert.doesNotMatch(placeholder, /animate-spin|animate-pulse/)
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
  assert.match(markup, /工作了 6秒/)
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
