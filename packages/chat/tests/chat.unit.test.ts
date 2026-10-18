import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { PiGenerationMetrics } from '@pi-meme/contracts/pi'
import { applyEvent, emptyChat, fromSnapshot } from '../src/ui/model/state'
import { messageText } from '../src/ui/model/message-text'
import { groupConversationTurns } from '../src/ui/model/conversation-turns'
import {
  toolResult,
  assistantMessage,
  bashMessage,
  sessionState,
  streamUpdate,
  userMessage,
  zeroUsage,
} from '../../../tests/fixtures/messages.mjs'

function startLive(timestamp = 1) {
  return applyEvent(applyEvent(emptyChat, { type: 'agent_start' }), {
    type: 'message_start',
    message: assistantMessage([], timestamp),
  })
}

test('生成指标随流式事件更新，快照恢复不沿用其他会话的指标', () => {
  const metrics: PiGenerationMetrics = {
    running: true,
    phase: 'generating',
    elapsedMs: 2000,
    generationMs: 1500,
    generationActive: true,
    ttftMs: 1000,
    outputTokens: 50,
    estimated: true,
  }
  const started = startLive()
  const next = applyEvent(started, {
    ...streamUpdate({ type: 'text_delta', contentIndex: 0, delta: '正文' }),
    generationMetrics: metrics,
  })
  assert.equal(next.generationMetrics?.outputTokens, 50)
  assert.equal(typeof next.generationMetrics?.receivedAt, 'number')
  assert.equal(started.generationMetrics, undefined)
  const snapshot = {
    connection: { generation: 1, cwd: '/', status: 'ready' as const },
    state: { ...sessionState(), mode: 'default' as const, generationMetrics: metrics },
    messages: [],
    models: [],
  }
  assert.equal(fromSnapshot(snapshot).generationMetrics?.ttftMs, 1000)
  assert.equal(
    fromSnapshot({ ...snapshot, state: { ...snapshot.state, generationMetrics: undefined } }).generationMetrics,
    undefined,
  )
})

test('最终消息替换流式内容，重复 message_end 不添加副本，agent_end 不代表空闲', () => {
  let state = startLive()
  state = applyEvent(state, streamUpdate({ type: 'text_start', contentIndex: 0 }))
  state = applyEvent(state, streamUpdate({ type: 'text_delta', contentIndex: 0, delta: '片段' }))
  assert.equal(messageText(state.live), '片段')
  const message = assistantMessage('最终正文', 1)
  state = applyEvent(state, { type: 'message_end', message })
  state = applyEvent(state, { type: 'message_end', message })
  state = applyEvent(state, { type: 'agent_end', messages: [message], willRetry: false })
  assert.equal(state.messages.length, 1)
  assert.equal(state.live, null)
  assert.equal(state.running, true)
  assert.equal(messageText(state.messages[0]), '最终正文')
  state = applyEvent(state, { type: 'agent_settled' })
  assert.equal(state.running, false)
  assert.deepEqual(state.stream, emptyChat.stream)
})

test('快照包含最终消息时，回放旧增量不会重新显示临时回复', () => {
  const message = assistantMessage('最终正文', 2)
  let state = fromSnapshot({
    connection: { generation: 1, cwd: '/', status: 'ready' },
    state: { ...sessionState(), mode: 'default' as const },
    messages: [message],
    models: [],
  })
  state = applyEvent(state, { type: 'message_start', message: assistantMessage([], 2) })
  state = applyEvent(state, streamUpdate({ type: 'text_start', contentIndex: 0 }))
  state = applyEvent(state, streamUpdate({ type: 'text_delta', contentIndex: 0, delta: '最终' }))
  state = applyEvent(state, { type: 'message_end', message })
  assert.equal(state.messages.length, 1)
  assert.equal(state.live, null)
})

test('未知工具的执行中、部分结果、成功与失败，结束后忽略旧更新', () => {
  let state = applyEvent(emptyChat, {
    type: 'tool_execution_start',
    toolCallId: '1',
    toolName: 'custom',
    args: { file: 'x' },
  })
  assert.equal(state.tools['1'].status, 'running')
  state = applyEvent(state, {
    type: 'tool_execution_update',
    toolCallId: '1',
    toolName: 'custom',
    args: { file: 'x' },
    partialResult: '部分结果',
  })
  assert.equal(state.tools['1'].result, '部分结果')
  state = applyEvent(state, {
    type: 'tool_execution_end',
    toolCallId: '1',
    toolName: 'custom',
    result: '完成',
    isError: false,
  })
  assert.equal(state.tools['1'].status, 'success')
  assert.deepEqual(state.tools['1'].args, { file: 'x' })
  const finished = state
  state = applyEvent(state, {
    type: 'tool_execution_update',
    toolCallId: '1',
    toolName: 'custom',
    args: {},
    partialResult: '过期结果',
  })
  assert.equal(state, finished)
  state = applyEvent(state, {
    type: 'tool_execution_end',
    toolCallId: '2',
    toolName: 'other',
    result: '失败',
    isError: true,
  })
  assert.equal(state.tools['2'].status, 'error')
})

test('队列事件同步插话和后续任务，结束事件保留队列直到队列事件更新', () => {
  let state = applyEvent(emptyChat, {
    type: 'queue_update',
    steering: [{ id: 'steer', text: '先看一下当前改动', mode: 'default' as const }],
    followUp: [{ id: 'follow', text: '完成后运行检查', mode: 'default' as const }],
  })
  assert.equal(state.steering[0]?.text, '先看一下当前改动')
  assert.equal(state.followUp[0]?.text, '完成后运行检查')
  const queued = state
  state = applyEvent(state, { type: 'agent_settled' })
  assert.deepEqual(state.steering, queued.steering)
  assert.deepEqual(state.followUp, queued.followUp)
  state = applyEvent(state, { type: 'queue_update', steering: [], followUp: [] })
  assert.deepEqual(state.steering, [])
  assert.deepEqual(state.followUp, [])
})

test('messageText 处理正文、Bash 和没有正文的正式摘要消息', () => {
  assert.equal(messageText(null), '')
  assert.equal(messageText(undefined), '')
  assert.equal(messageText({ role: 'compactionSummary', summary: '摘要', tokensBefore: 100, timestamp: 1 }), '')
  assert.equal(messageText(bashMessage('pwd', '/Users/test\n')), '/Users/test\n')
  assert.equal(messageText(userMessage('普通文本')), '普通文本')
  assert.equal(
    messageText(
      assistantMessage([
        { type: 'text', text: '片段一' },
        { type: 'thinking', thinking: '思考中' },
        { type: 'text', text: '片段二' },
      ]),
    ),
    '片段一片段二',
  )
})

test('正文与思考按 contentIndex 分别更新，结束状态不依赖整个 Agent 是否运行', () => {
  let state = startLive()
  state = applyEvent(state, streamUpdate({ type: 'thinking_start', contentIndex: 0 }))
  state = applyEvent(state, streamUpdate({ type: 'thinking_delta', contentIndex: 0, delta: '分析' }))
  const prior = state
  state = applyEvent(state, streamUpdate({ type: 'thinking_delta', contentIndex: 0, delta: '中' }))
  assert.deepEqual(prior.live?.content, [{ type: 'thinking', thinking: '分析' }])
  state = applyEvent(state, streamUpdate({ type: 'thinking_end', contentIndex: 0, content: '分析完成' }))
  const turns = groupConversationTurns([], state.live, {}, true, state.stream.completed)
  assert.ok(turns[0].type === 'assistant_turn')
  assert.equal(turns[0].activities[0].status, 'success')
  state = applyEvent(state, streamUpdate({ type: 'text_start', contentIndex: 1 }))
  state = applyEvent(state, streamUpdate({ type: 'text_delta', contentIndex: 1, delta: '第一段' }))
  state = applyEvent(state, streamUpdate({ type: 'text_end', contentIndex: 1, content: '第一段完成' }))
  state = applyEvent(state, streamUpdate({ type: 'text_start', contentIndex: 2 }))
  state = applyEvent(state, {
    ...streamUpdate({ type: 'text_delta', contentIndex: 2, delta: '第二段' }),
    usage: { ...zeroUsage(), output: 4, totalTokens: 4 },
  })
  assert.deepEqual(state.live?.content, [
    { type: 'thinking', thinking: '分析完成' },
    { type: 'text', text: '第一段完成' },
    { type: 'text', text: '第二段' },
  ])
  assert.equal(state.live?.usage.output, 4)
  assert.equal(state.live?.model, 'first')
  assert.equal(state.live?.timestamp, 1)
})

test('工具参数累积未完成 JSON，结束时以正式 ToolCall 替换并清理临时缓冲', () => {
  let state = startLive()
  state = applyEvent(state, streamUpdate({ type: 'toolcall_start', contentIndex: 0, id: 'call', toolName: 'read' }))
  state = applyEvent(state, streamUpdate({ type: 'toolcall_delta', contentIndex: 0, delta: '{"path":"src/' }))
  assert.equal(state.stream.arguments[0], '{"path":"src/')
  state = applyEvent(state, streamUpdate({ type: 'toolcall_delta', contentIndex: 0, delta: 'main.ts"}' }))
  assert.deepEqual(state.live?.content[0], {
    type: 'toolCall',
    id: 'call',
    name: 'read',
    arguments: { path: 'src/main.ts' },
  })
  const toolCall = { type: 'toolCall' as const, id: 'call', name: 'read', arguments: { path: 'src/final.ts' } }
  state = applyEvent(state, streamUpdate({ type: 'toolcall_end', contentIndex: 0, toolCall }))
  assert.deepEqual(state.live?.content[0], toolCall)
  assert.equal(state.stream.arguments[0], undefined)
  assert.equal(state.stream.completed[0], true)
})

test('没有 message_start 的增量不会伪造 assistant 消息，索引缺口不会产生稀疏内容', () => {
  assert.equal(applyEvent(emptyChat, streamUpdate({ type: 'text_delta', contentIndex: 0, delta: '旧增量' })), emptyChat)
  const state = startLive()
  assert.deepEqual(applyEvent(state, streamUpdate({ type: 'text_start', contentIndex: 8 })), state)
})

test('done/error 保留正式消息，message_end 后才进入历史并去重', () => {
  for (const reason of ['stop', 'error', 'aborted'] as const) {
    let state = startLive()
    state = applyEvent(state, streamUpdate({ type: 'thinking_start', contentIndex: 0 }))
    const final = assistantMessage('已有内容', 1, {
      stopReason: reason,
      ...(reason === 'stop' ? {} : { errorMessage: '生成已终止' }),
    })
    state = applyEvent(
      state,
      reason === 'stop'
        ? streamUpdate({ type: 'done', reason, message: final })
        : streamUpdate({ type: 'error', reason, error: final }),
    )
    assert.deepEqual(state.live, final)
    assert.equal(state.stream.completed[0], true)
    assert.equal(state.messages.length, 0)
    state = applyEvent(state, { type: 'message_end', message: final })
    assert.deepEqual(state.messages, [final])
    assert.equal(state.live, null)
  }
})

test('快照与缓冲增量按会话、代次和 sequence 去重，只追加快照之后的正文', async () => {
  const { restoreSnapshot } = await import('../src/ui/model/state')
  const connection = { generation: 2, sessionKey: 'target', cwd: '/', status: 'ready' as const }
  const start = {
    generation: 2,
    sessionKey: 'target',
    sequence: 1,
    event: { type: 'message_start' as const, message: assistantMessage([], 10) },
  }
  const delta = {
    generation: 2,
    sessionKey: 'target',
    sequence: 3,
    event: streamUpdate({ type: 'text_delta', contentIndex: 0, delta: '正文' }),
  }
  const snapshot = {
    connection,
    state: { ...sessionState({ isStreaming: true }), mode: 'default' as const },
    messages: [],
    models: [],
    eventSequence: 3,
    events: [
      start,
      { ...start, sequence: 2, event: streamUpdate({ type: 'text_start', contentIndex: 0 }) },
      { ...delta, generation: 1 },
      { ...delta, sessionKey: 'other' },
      delta,
      delta,
    ],
  }
  const state = restoreSnapshot(snapshot, [
    delta,
    { ...delta, sequence: 4, event: streamUpdate({ type: 'text_delta', contentIndex: 0, delta: '追加' }) },
  ])
  assert.equal(messageText(state.live), '正文追加')
})

test('codemode 内部工具按父调用归组，历史从 nestedCalls 恢复且不重复显示顶层活动', () => {
  const assistant = assistantMessage([
    { type: 'toolCall', id: 'code', name: 'codemode', arguments: { code: 'text(await tools.read({path:"a"}))' } },
  ])
  let state = applyEvent(emptyChat, { type: 'message_end', message: assistant })
  state = applyEvent(state, {
    type: 'tool_execution_start',
    toolCallId: 'code/tool/1',
    parentToolCallId: 'code',
    toolName: 'read',
    args: { path: 'a' },
  })
  state = applyEvent(state, {
    type: 'tool_execution_end',
    toolCallId: 'code/tool/1',
    parentToolCallId: 'code',
    toolName: 'read',
    result: { content: [{ type: 'text', text: '内容' }] },
    isError: false,
  })
  const result: Extract<import('@pi-meme/contracts/pi').PiMessage, { role: 'toolResult' }> = {
    role: 'toolResult',
    toolCallId: 'code',
    toolName: 'codemode',
    content: [{ type: 'text', text: '脚本完成' }],
    isError: false,
    timestamp: 2,
    nestedCalls: {
      complete: true,
      calls: [{ id: 'code/tool/1', name: 'read', arguments: { path: 'a' }, status: 'ok' }],
    },
  }
  state = applyEvent(state, { type: 'message_end', message: result })
  let turns = groupConversationTurns(state.messages, null, state.tools, false)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].type, 'assistant_turn')
  if (turns[0].type !== 'assistant_turn') return
  assert.equal(turns[0].activities.length, 1)
  const parent = turns[0].activities[0]
  if (parent.type === 'thinking' || parent.type === 'narration') return
  assert.equal(parent.children?.[0].id, 'code/tool/1')
  assert.deepEqual(parent.children?.[0].result, { content: [{ type: 'text', text: '内容' }] })
  const restored = fromSnapshot({
    connection: { cwd: '/tmp', generation: 1, status: 'idle' },
    messages: [assistant, result],
    state: { ...sessionState(), mode: 'default' as const },
    models: [],
  })
  turns = groupConversationTurns(restored.messages, null, restored.tools, false)
  if (turns[0].type !== 'assistant_turn') return
  const historical = turns[0].activities[0]
  assert.equal(historical.type, 'tool')
  if (historical.type !== 'tool') return
  assert.equal(historical.children?.[0].status, 'success')
  assert.deepEqual(historical.children?.[0].args, { path: 'a' })
})

test('工具事件、实时消息与恢复快照保留Host注册来源，技能读取状态可观察', () => {
  const source = { ownerId: 'demo-plugin', generation: 7, toolName: 'demo_tool' }
  let state = applyEvent(emptyChat, {
    type: 'tool_execution_start',
    toolCallId: 'source-tool',
    toolName: 'demo_tool',
    args: {},
    source,
  })
  state = applyEvent(state, {
    type: 'message_end',
    message: { ...toolResult('source-tool', '结果', 10), toolName: 'demo_tool' },
    source,
  })
  assert.deepEqual(state.tools['source-tool'].source, source)
  assert.deepEqual(state.messages.at(-1)?.source, source)
  const usages = [
    {
      id: 'skill-id',
      revision: 'r1',
      name: 'skill:demo',
      path: '/snapshot/SKILL.md',
      source: 'implicit-read' as const,
      toolCallId: 'source-tool',
      inherited: false,
    },
  ]
  state = applyEvent(state, { type: 'skill_usage_update', usages })
  assert.deepEqual(state.skillUsages, usages)
  const restored = fromSnapshot({
    connection: { generation: 1, cwd: '/', status: 'ready' },
    state: { ...sessionState(), mode: 'default', skillUsages: usages },
    messages: state.messages,
    models: [],
  })
  assert.deepEqual(restored.tools['source-tool'].source, source)
  assert.deepEqual(restored.skillUsages, usages)
})
