import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PiEvent } from '@pi-meme/contracts/pi'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { assistantMessage, bashMessage, sessionState, userMessage } from '../../../tests/fixtures/messages.mjs'
import { AssistantTurnView } from '../src/ui/conversation/assistant-turn'
import { ChatMessage } from '../src/ui/conversation/chat-message'
import { Conversation } from '../src/ui/conversation/conversation'
import { ToolActivityRow } from '../src/ui/conversation/tool-activity-row'
import { groupConversationTurns } from '../src/ui/model/conversation-turns'
import { applyEvent, emptyChat, fromSnapshot, restoreSnapshot } from '../src/ui/model/state'
import type { ChatState } from '../src/ui/model/types'

function noop() {}
const failure = assistantMessage('', 2000, { stopReason: 'error', errorMessage: 'network error\n请求超时：/api/chat' })

function renderConversation(chat: ChatState) {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(Conversation, {
        chat,
        canEditMessages: false,
        onEditMessage: noop,
        onSwitchMessageVersion: noop,
        onForkReply: noop,
        onCopyError: noop,
      }),
    ),
  )
}

test('模型错误只渲染红字摘要和默认折叠的完整原因，两条消息渲染路径一致', () => {
  const turn = groupConversationTurns([userMessage('任务', 1000), failure], null, {}, false)[1]!
  assert.equal(turn.type, 'assistant_turn')
  if (turn.type !== 'assistant_turn') return
  for (const element of [
    createElement(AssistantTurnView, { turn }),
    createElement(ChatMessage, { message: failure, tools: {} }),
  ]) {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, element))
    assert.match(html, /<details/)
    assert.match(html, /请求超时：\/api\/chat/)
    assert.doesNotMatch(html, /border-destructive|bg-destructive|lucide-circle-alert|<details[^>]* open/)
    assert.match(html, /text-destructive/)
  }
})

test('后续成功回复清除同轮旧错误，原始消息和上一轮最终失败仍保留', () => {
  const messages = [userMessage('任务', 1000), failure, assistantMessage('已经完成', 3000)]
  const turn = groupConversationTurns(messages, null, {}, false)[1]!
  assert.equal(turn.type === 'assistant_turn' && turn.errorMessage, undefined)
  assert.equal(failure.errorMessage, 'network error\n请求超时：/api/chat')
  const history = groupConversationTurns(
    [userMessage('任务', 1000), failure, userMessage('下一轮', 4000)],
    null,
    {},
    false,
  )
  assert.equal(history[1]?.type === 'assistant_turn' && history[1].errorMessage, failure.errorMessage)
})

test('工具失败保留可读摘要与折叠输出，图标和详情容器不变红', () => {
  const html = renderToStaticMarkup(
    createElement(ToolActivityRow, {
      item: { id: 'read', name: 'read', args: { path: 'missing.ts' }, result: 'ENOENT', status: 'error' },
      open: false,
      onToggle: noop,
      isLive: false,
    }),
  )
  assert.match(html, /text-destructive/)
  assert.match(html, /ENOENT/)
  assert.doesNotMatch(html, /border-destructive|bg-destructive|lucide-circle-x|<svg[^>]*text-destructive/)
})

test('独立命令非零退出按失败显示，主动取消和助手中断不新增错误行', () => {
  const command = { ...bashMessage('false', 'exit 1', 2000), exitCode: 1 }
  const turn = groupConversationTurns([userMessage('任务', 1000), command], null, {}, false)[1]!
  assert.equal(turn.type === 'assistant_turn' && turn.activities[0]?.status, 'error')
  const html = renderToStaticMarkup(createElement(ChatMessage, { message: command, tools: {} }))
  assert.match(html, /text-destructive/)
  const cancelled = groupConversationTurns(
    [userMessage('任务', 1000), { ...command, cancelled: true }],
    null,
    {},
    false,
  )[1]!
  assert.equal(cancelled.type === 'assistant_turn' && cancelled.activities[0]?.status, 'success')
  const aborted = assistantMessage('', 2000, { stopReason: 'aborted', errorMessage: '已中断' })
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(ChatMessage, { message: aborted, tools: {} })),
    /data-error-line/,
  )
})

test('真实重试次数只出现在一条摘要中，成功后自然消失', () => {
  let state: ChatState = { ...emptyChat, messages: [userMessage('任务', 1000), failure], running: true }
  const retry = {
    type: 'auto_retry_start',
    attempt: 2,
    maxAttempts: 7,
    delayMs: 4000,
    errorMessage: failure.errorMessage,
  } as PiEvent
  state = applyEvent(state, retry)
  assert.ok(state)
  assert.equal(state.retry?.attempt, 2)
  assert.equal(state.retry?.maxAttempts, 7)
  const html = renderConversation(state)
  assert.equal((html.match(/data-error-line=""/g) ?? []).length, 1)
  assert.match(html, /重试中（2\/7）/)
  assert.doesNotMatch(html, /border-destructive|bg-destructive/)
  state = applyEvent(state, { type: 'message_end', message: assistantMessage('已经完成', 3000) })
  state = applyEvent(state, { type: 'auto_retry_end', success: true, attempt: 2 } as PiEvent)
  state = applyEvent(state, { type: 'agent_settled' })
  assert.equal(state.retry, undefined)
  const success = renderConversation(state)
  assert.match(success, /已经完成/)
  assert.doesNotMatch(success, /network error|重试中|连接已恢复|data-error-line/)
})

test('重试耗尽保留最终失败，开始新一轮不会泄漏旧重试次数', () => {
  let state = applyEvent({ ...emptyChat, messages: [userMessage('任务', 1000), failure] }, {
    type: 'auto_retry_start',
    attempt: 3,
    maxAttempts: 3,
    delayMs: 1000,
    errorMessage: 'network error',
  } as PiEvent)
  state = applyEvent(state, {
    type: 'auto_retry_end',
    success: false,
    attempt: 3,
    finalError: 'network error',
  } as PiEvent)
  state = applyEvent(state, { type: 'agent_settled' })
  assert.ok(state)
  assert.equal(state.retry, undefined)
  assert.match(renderConversation(state), /network error/)
  assert.doesNotMatch(renderConversation(state), /重试中|连接已恢复/)
  state = applyEvent(state, { type: 'message_end', message: userMessage('新任务', 4000) })
  state = applyEvent(state, { type: 'agent_start' })
  assert.equal(state.retry, undefined)
})

test('切回会话从快照恢复等待中的重试，事件回放成功后移除进度', () => {
  const snapshot = {
    connection: { generation: 1, status: 'ready' as const, cwd: '/test', sessionKey: 'session' },
    state: {
      ...sessionState(),
      mode: 'default' as const,
      retry: {
        kind: 'model' as const,
        attempt: 1,
        maxAttempts: 4,
        delayMs: 2000,
        errorMessage: 'network error',
      },
    },
    messages: [userMessage('任务', 1000), failure],
    models: [],
    eventSequence: 1,
  }
  const restored = fromSnapshot(snapshot)
  assert.equal(restored.retry?.attempt, 1)
  assert.equal(restored.running, true)
  const settled = restoreSnapshot(snapshot, [
    {
      generation: 1,
      sessionKey: 'session',
      sequence: 2,
      event: { type: 'message_end', message: assistantMessage('已经完成', 3000) },
    },
    {
      generation: 1,
      sessionKey: 'session',
      sequence: 3,
      event: { type: 'auto_retry_end', success: true, attempt: 1 } as PiEvent,
    },
    { generation: 1, sessionKey: 'session', sequence: 4, event: { type: 'agent_settled' } },
  ])
  assert.equal(settled.retry, undefined)
  assert.doesNotMatch(renderConversation(settled), /network error|重试中|连接已恢复/)
})

test('压缩失败保留摘要和原因，压缩重试成功后移除提示，主动取消不报错', () => {
  let state = applyEvent(emptyChat, { type: 'compaction_start', reason: 'threshold' })
  state = applyEvent(state, {
    type: 'compaction_end',
    reason: 'threshold',
    result: undefined,
    aborted: false,
    willRetry: false,
    errorMessage: '摘要请求失败',
  })
  assert.equal(state.compactionError, '摘要请求失败')
  assert.match(renderConversation(state), /上下文压缩失败/)
  state = applyEvent(state, {
    type: 'summarization_retry_scheduled',
    attempt: 1,
    maxAttempts: 2,
    delayMs: 2000,
    errorMessage: '摘要请求失败',
  } as PiEvent)
  assert.equal(state.retry?.kind, 'summary')
  assert.match(renderConversation(state), /重试中（1\/2）/)
  state = applyEvent(state, { type: 'compaction_start', reason: 'threshold' })
  state = applyEvent(state, { type: 'summarization_retry_finished' } as PiEvent)
  state = applyEvent(state, {
    type: 'compaction_end',
    reason: 'threshold',
    result: undefined,
    aborted: false,
    willRetry: false,
  })
  assert.equal(state.compactionError, undefined)
  assert.equal(state.retry, undefined)
  assert.doesNotMatch(renderConversation(state), /data-error-line|连接已恢复/)
  state = applyEvent(state, {
    type: 'compaction_end',
    reason: 'manual',
    result: undefined,
    aborted: true,
    willRetry: false,
    errorMessage: '已取消',
  })
  assert.equal(state.compactionError, undefined)
})
