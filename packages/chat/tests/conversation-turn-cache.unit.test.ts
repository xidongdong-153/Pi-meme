import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { PiMessage } from '@pi-meme/contracts/pi'
import { createConversationTurnProjector, groupConversationTurns } from '../src/ui/model/conversation-turns'
import { assistantMessage, userMessage } from '../../../tests/fixtures/messages.mjs'

test('流式分组复用已完成轮次，正文和时间戳回退仍与完整分组一致', () => {
  const messages: PiMessage[] = [
    userMessage('历史提问', 1),
    assistantMessage('历史回复', 2),
    userMessage('当前提问', 3),
  ]
  const project = createConversationTurnProjector()
  const tools = {}
  const intervals: [] = []
  const first = project(messages, assistantMessage('第一段', 4), tools, true, {}, [], intervals)
  const next = project(messages, assistantMessage('第一段继续', 4), tools, true, {}, [], intervals)
  assert.equal(next[0], first[0])
  assert.equal(next[1], first[1])
  assert.deepEqual(
    next,
    groupConversationTurns(messages, assistantMessage('第一段继续', 4), tools, true, {}, [], intervals),
  )
  const earlier = assistantMessage('更早的事件', 0)
  assert.deepEqual(project(messages, earlier, tools, true), groupConversationTurns(messages, earlier, tools, true))
})
