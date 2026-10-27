import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopEvent } from '@pi-meme/contracts/desktop'
import { createStreamCoalescer } from '../src/stream-coalescer'
import { streamUpdate } from '../../../tests/fixtures/messages.mjs'

afterEach(() => vi.useRealTimers())

function update(
  text: string,
  type: 'text_delta' | 'thinking_delta' | 'toolcall_delta' = 'text_delta',
  contentIndex = 0,
): DesktopEvent {
  return { generation: 1, event: streamUpdate({ type, contentIndex, delta: text }) }
}

test('同一内容块按 16ms 合并，保留所有字符', () => {
  vi.useFakeTimers()
  const events: DesktopEvent[] = []
  const stream = createStreamCoalescer((event) => events.push(event))
  for (let i = 0; i < 100; i++) stream.push(update(String(i)))
  expect(events).toHaveLength(0)
  vi.advanceTimersByTime(16)
  expect(events).toEqual([update(Array.from({ length: 100 }, (_, i) => String(i)).join(''))])
})

test('思考、文本、工具参数和完成边界保持顺序', () => {
  const events: DesktopEvent[] = []
  const stream = createStreamCoalescer((event) => events.push(event))
  stream.push(update('思', 'thinking_delta'))
  stream.push(update('考', 'thinking_delta'))
  stream.push(update('正', 'text_delta', 1))
  stream.push(update('文', 'text_delta', 1))
  stream.push(update('{', 'toolcall_delta', 2))
  stream.push(update('}', 'toolcall_delta', 2))
  const end: DesktopEvent = { generation: 1, event: { type: 'agent_settled', aborted: false } }
  stream.push(end)
  expect(events).toEqual([
    update('思考', 'thinking_delta'),
    update('正文', 'text_delta', 1),
    update('{}', 'toolcall_delta', 2),
    end,
  ])
})

test('字节上限、执行代次变化和显式快照边界立即发送', () => {
  const events: DesktopEvent[] = []
  const stream = createStreamCoalescer((event) => events.push(event))
  stream.push(update('文'.repeat(12000)))
  expect(events).toHaveLength(1)
  stream.push(update('旧'))
  stream.push({ ...update('新'), generation: 2 })
  stream.flush()
  expect(events.slice(1)).toEqual([update('旧'), { ...update('新'), generation: 2 }])
})
