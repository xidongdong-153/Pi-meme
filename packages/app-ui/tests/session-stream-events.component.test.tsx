import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopEvent } from '@pi-meme/contracts/desktop'
import { SessionStreamEvents } from '../src/session/stream-events'
import { streamUpdate } from '../../../tests/fixtures/messages.mjs'

afterEach(() => vi.useRealTimers())
function delta(key: string, value: string): DesktopEvent {
  return { sessionKey: key, generation: 1, event: streamUpdate({ type: 'text_delta', contentIndex: 0, delta: value }) }
}

test('后台增量每 250ms 合并，未缓存会话不构建聊天状态', () => {
  vi.useFakeTimers()
  const records: DesktopEvent[] = []
  const queue = new SessionStreamEvents(
    (record) => records.push(record),
    () => false,
    (key) => key === 'background',
  )
  queue.push(delta('ignored', '不保留'))
  queue.push(delta('background', '第一'))
  queue.push(delta('background', '第二'))
  vi.advanceTimersByTime(249)
  expect(records).toHaveLength(0)
  vi.advanceTimersByTime(1)
  expect(records).toEqual([delta('background', '第一第二')])
  queue.dispose()
})

test('终止事件先提交待更新文字，卸载取消剩余回调', () => {
  vi.useFakeTimers()
  const records: DesktopEvent[] = []
  const queue = new SessionStreamEvents(
    (record) => records.push(record),
    () => false,
    () => true,
  )
  queue.push(delta('a', '最后的文字'))
  const end: DesktopEvent = { sessionKey: 'a', generation: 1, event: { type: 'agent_settled', aborted: false } }
  queue.push(end)
  expect(records).toEqual([delta('a', '最后的文字'), end])
  queue.push(delta('b', '过期'))
  queue.dispose()
  vi.runAllTimers()
  expect(records).toHaveLength(2)
})

test('内容块结束立即提交，不等待后台批次', () => {
  const records: DesktopEvent[] = []
  const queue = new SessionStreamEvents(
    (record) => records.push(record),
    () => false,
    () => true,
  )
  queue.push(delta('a', '正文'))
  const end: DesktopEvent = {
    sessionKey: 'a',
    generation: 1,
    event: streamUpdate({ type: 'text_end', contentIndex: 0, content: '正文' }),
  }
  queue.push(end)
  expect(records).toEqual([delta('a', '正文'), end])
  queue.dispose()
})
