import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { PiMessage } from '@pi-meme/contracts/pi'
import { groupConversationTurns } from '../src/ui/model/conversation-turns'
import { formatMessageTime, formatMessageTimeTitle } from '../src/ui/model/message-time'
import { assistantMessage, userMessage } from '../../../tests/fixtures/messages.mjs'

const now = new Date(2026, 2, 18, 15, 4, 30).getTime()

function at(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month, day, hour, minute, 0, 0).getTime()
}

test('消息时间按今天、昨天、近一周、今年和跨年显示', () => {
  assert.equal(formatMessageTime(at(2026, 2, 18, 9, 43), now), '09:43')
  assert.equal(formatMessageTime(at(2026, 2, 18, 0, 0), now), '00:00')
  assert.equal(formatMessageTime(at(2026, 2, 18, 23, 59), now), '23:59')
  assert.equal(formatMessageTime(at(2026, 2, 17, 9, 43), now), '昨天 09:43')
  assert.equal(formatMessageTime(at(2026, 2, 16, 9, 43), now), '星期一 09:43')
  assert.equal(formatMessageTime(at(2026, 2, 12, 9, 43), now), '星期四 09:43')
  assert.equal(formatMessageTime(at(2026, 2, 11, 9, 43), now), '3月11日 09:43')
  assert.equal(formatMessageTime(at(2026, 0, 2, 8, 5), now), '1月2日 08:05')
  assert.equal(formatMessageTime(at(2025, 11, 31, 9, 43), now), '2025年12月31日 09:43')
  assert.equal(formatMessageTime(at(2026, 2, 19, 9, 43), now), '2026年3月19日 09:43')
  assert.equal(formatMessageTime(at(2027, 0, 1, 0, 1), now), '2027年1月1日 00:01')
})

test('跨年的近几天仍显示星期，元旦的昨天不显示成去年月日', () => {
  const newYear = new Date(2026, 0, 1, 10, 0).getTime()
  assert.equal(formatMessageTime(at(2025, 11, 31, 9, 43), newYear), '昨天 09:43')
  assert.equal(formatMessageTime(at(2025, 11, 30, 9, 43), newYear), '星期二 09:43')
  assert.equal(formatMessageTime(at(2025, 11, 26, 9, 43), newYear), '星期五 09:43')
  assert.equal(formatMessageTime(at(2025, 11, 25, 9, 43), newYear), '2025年12月25日 09:43')
})

test('非法时间不渲染，完整标题始终保留年月日和星期', () => {
  assert.equal(formatMessageTime(Number.NaN, now), '')
  assert.equal(formatMessageTime(Number.POSITIVE_INFINITY, now), '')
  assert.equal(formatMessageTimeTitle(Number.NaN), '')
  assert.equal(formatMessageTimeTitle(at(2026, 2, 18, 9, 43)), '2026年3月18日 星期三 09:43')
  assert.equal(formatMessageTimeTitle(at(2025, 11, 31, 9, 43)), '2025年12月31日 星期三 09:43')
})

test('助手回复时间优先用完成时间，不用开启这轮的用户时间', () => {
  const completedAt = at(2020, 5, 15, 9, 43)
  const reply = { ...assistantMessage('完成', 5_000), completedAt } as PiMessage
  const turns = groupConversationTurns([userMessage('问', 1_000), reply], null, {}, false)
  const turn = turns.find((item) => item.type === 'assistant_turn')
  assert.equal(turn?.type === 'assistant_turn' ? turn.repliedAt : undefined, completedAt)
  assert.equal(turn?.type === 'assistant_turn' ? turn.startedAt : undefined, 1_000)
  const missing = groupConversationTurns([userMessage('问', 1_000), assistantMessage('完成', 5_000)], null, {}, false)
  const fallback = missing.find((item) => item.type === 'assistant_turn')
  assert.equal(fallback?.type === 'assistant_turn' ? fallback.repliedAt : undefined, 5_000)
})
