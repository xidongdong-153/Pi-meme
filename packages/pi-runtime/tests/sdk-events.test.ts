import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { toDesktopEvent } from '../src/sdk/events'

test('toDesktopEvent 忽略桌面端不需要的事件类型', () => {
  const ignoredEvent = { type: 'turn_start' } as unknown as AgentSessionEvent
  assert.equal(toDesktopEvent(ignoredEvent), null)
})

test('toDesktopEvent 原样透传非 message_update 的白名单事件', () => {
  const startEvent = { type: 'agent_start' } as AgentSessionEvent
  assert.equal(toDesktopEvent(startEvent), startEvent)

  const queueEvent = { type: 'queue_update' } as AgentSessionEvent
  assert.equal(toDesktopEvent(queueEvent), null)
})

test('toDesktopEvent 转换 toolcall_start 事件并剥离 partial', () => {
  const event = {
    type: 'message_update',
    message: {
      role: 'assistant',
      usage: { inputTokens: 10, outputTokens: 20 },
    },
    assistantMessageEvent: {
      type: 'toolcall_start',
      contentIndex: 0,
      partial: {
        content: [{ type: 'toolCall', id: 'call_123', name: 'read' }],
      },
    },
  } as unknown as AgentSessionEvent

  const converted = toDesktopEvent(event)
  assert.notEqual(converted, null)
  assert.equal(converted?.type, 'message_update')
  if (converted?.type === 'message_update') {
    assert.deepEqual(converted.usage, { inputTokens: 10, outputTokens: 20 })
    assert.deepEqual(converted.assistantMessageEvent, {
      type: 'toolcall_start',
      contentIndex: 0,
      id: 'call_123',
      toolName: 'read',
    })
    assert.equal('partial' in converted.assistantMessageEvent, false)
  }
})

test('toDesktopEvent 剥离普通 delta 事件中的 partial', () => {
  const event = {
    type: 'message_update',
    message: {
      role: 'assistant',
    },
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'hello',
      partial: { content: ['hello'] },
    },
  } as unknown as AgentSessionEvent

  const converted = toDesktopEvent(event)
  assert.equal(converted?.type, 'message_update')
  if (converted?.type === 'message_update') {
    assert.deepEqual(converted.assistantMessageEvent, {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'hello',
    })
  }
})

test('toDesktopEvent 在 message_update 遇到非助手角色时抛错', () => {
  const event = {
    type: 'message_update',
    message: { role: 'user' },
    assistantMessageEvent: { type: 'text_delta' },
  } as unknown as AgentSessionEvent

  assert.throws(() => toDesktopEvent(event), /message_update 事件不是助手消息/)
})
