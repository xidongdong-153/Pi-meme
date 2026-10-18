import assert from 'node:assert/strict'
import { test } from 'vitest'
import { GenerationMetricsTracker } from '../src/sdk/generation-metrics'
import { assistantMessage, streamUpdate, zeroUsage } from '../../../tests/fixtures/messages.mjs'

function fixture() {
  let now = 0
  const tracker = new GenerationMetricsTracker(() => now)
  return {
    tracker,
    at: (value: number) => {
      now = value
    },
    start: () => {
      tracker.handle({ type: 'agent_start' })
      tracker.handle({ type: 'turn_start' })
    },
    end: (input: number, output: number) =>
      tracker.handle({
        type: 'message_end',
        message: assistantMessage('完成', 1, { usage: { ...zeroUsage(), input, output } }),
      }),
  }
}

test('首响应包含思考增量，流式输出用量由估算校准为实际值', () => {
  const { tracker, start, at, end } = fixture()
  start()
  at(1000)
  tracker.handle(streamUpdate({ type: 'text_delta', contentIndex: 0, delta: '' }))
  assert.equal(tracker.snapshot()?.ttftMs, undefined)
  at(2000)
  tracker.handle(streamUpdate({ type: 'thinking_delta', contentIndex: 0, delta: 'thinking' }))
  assert.equal(tracker.snapshot()?.ttftMs, 2000)
  assert.equal(tracker.snapshot()?.outputTokens, 2)
  assert.equal(tracker.snapshot()?.estimated, true)
  at(4000)
  tracker.handle({
    ...streamUpdate({ type: 'text_delta', contentIndex: 1, delta: 'done' }),
    usage: { ...zeroUsage(), input: 100, output: 30 },
  })
  assert.equal(tracker.snapshot()?.outputTokens, 30)
  assert.equal(tracker.snapshot()?.estimated, false)
  at(5000)
  end(100, 40)
  at(5100)
  tracker.handle({ type: 'agent_settled' })
  assert.deepEqual(tracker.snapshot(), {
    running: false,
    phase: 'complete',
    elapsedMs: 5100,
    generationMs: 5000,
    generationActive: false,
    ttftMs: 2000,
    outputTokens: 40,
    estimated: false,
  })
  at(10000)
  assert.equal(tracker.snapshot()?.elapsedMs, 5100)
})

test('汇总多次模型请求，生成耗时排除中间的工具执行时间', () => {
  const { tracker, start, at, end } = fixture()
  start()
  at(1000)
  tracker.handle(streamUpdate({ type: 'toolcall_delta', contentIndex: 0, delta: '{}' }))
  at(2000)
  end(100, 20)
  tracker.handle({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: {} })
  at(12000)
  assert.equal(tracker.snapshot()?.generationMs, 2000)
  assert.equal(tracker.snapshot()?.elapsedMs, 12000)
  assert.equal(tracker.snapshot()?.phase, 'tools')
  tracker.handle({ type: 'turn_start' })
  at(15000)
  end(150, 30)
  tracker.handle({ type: 'agent_settled' })
  const result = tracker.snapshot()!
  assert.equal(result.generationMs, 5000)
  assert.equal(result.elapsedMs, 15000)
  assert.equal(result.outputTokens, 50)
  assert.equal(result.ttftMs, 1000)
  assert.equal(result.outputTokens / (result.generationMs / 1000), 10)
})

test('中断保留已输出的估算数据，新运行和重置不沿用上一轮指标', () => {
  const { tracker, start, at } = fixture()
  assert.equal(tracker.snapshot(), undefined)
  start()
  at(2000)
  tracker.handle(streamUpdate({ type: 'text_delta', contentIndex: 0, delta: 'abcdefgh' }))
  at(3000)
  tracker.handle({ type: 'agent_settled', aborted: true })
  assert.equal(tracker.snapshot()?.phase, 'aborted')
  assert.equal(tracker.snapshot()?.outputTokens, 2)
  assert.equal(tracker.snapshot()?.estimated, true)
  at(4000)
  start()
  assert.equal(tracker.snapshot()?.outputTokens, 0)
  assert.equal(tracker.snapshot()?.ttftMs, undefined)
  assert.equal(tracker.snapshot()?.elapsedMs, 0)
  tracker.reset()
  tracker.handle(streamUpdate({ type: 'text_delta', contentIndex: 0, delta: '旧内容' }))
  assert.equal(tracker.snapshot(), undefined)
})

test('无输出和零耗时运行不产生虚构用量，agent_end 不提前停止计时', () => {
  const { tracker, start, end, at } = fixture()
  start()
  end(0, 0)
  tracker.handle({ type: 'agent_end', messages: [], willRetry: false })
  assert.equal(tracker.snapshot()?.running, true)
  tracker.handle({ type: 'agent_settled' })
  at(1000)
  assert.equal(tracker.snapshot()?.generationMs, 0)
  assert.equal(tracker.snapshot()?.outputTokens, 0)
  assert.equal(tracker.snapshot()?.estimated, false)
})
