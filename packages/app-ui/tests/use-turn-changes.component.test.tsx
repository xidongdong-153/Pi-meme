import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { DesktopEvent } from '@pi-meme/contracts/desktop'
import { emptyChat } from '@pi-meme/chat/ui/model/state'
import { useTurnChanges } from '../src/session/use-turn-changes'
import { userMessage } from '../../../tests/fixtures/messages.mjs'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fixture() {
  let receive: (event: DesktopEvent) => void = () => {}
  const summaries = vi
    .fn()
    .mockResolvedValue([{ entryId: 'u', files: [], insertions: 0, deletions: 0, undone: false, revision: '1' }])
  const host = {
    git: { turnChangeSummaries: summaries, undoTurn: vi.fn().mockResolvedValue(undefined) },
  } as unknown as HostApi
  const session = { hostId: 'h', sessionId: 's' }
  const chat = {
    ...emptyChat,
    running: true,
    messages: [{ ...userMessage('问题', 1), sourceEntry: { id: 'u', type: 'message' as const, revision: '1' } }],
  }
  const onEvent = (listener: typeof receive) => {
    receive = listener
    return () => {
      receive = () => {}
    }
  }
  const event = () =>
    receive({ generation: 1, sessionKey: 'key', event: { type: 'turn_changes_update', entryId: 'u', revision: '2' } })
  return { host, session, chat, onEvent, event, summaries }
}

test('变更事件合并为一次刷新，慢请求期间只追加一次，空闲不轮询', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const { result } = renderHook(() => useTurnChanges(f.host, f.session, f.chat, true, f.onEvent, 'key'))
  await act(async () => {})
  expect(f.summaries).toHaveBeenCalledTimes(1)
  let finish!: (value: unknown[]) => void
  f.summaries.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await act(async () => {
    f.event()
    f.event()
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(f.summaries).toHaveBeenCalledTimes(2)
  await act(async () => {
    f.event()
    f.event()
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(f.summaries).toHaveBeenCalledTimes(2)
  await act(async () => {
    finish([])
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(f.summaries).toHaveBeenCalledTimes(3)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000)
  })
  expect(f.summaries).toHaveBeenCalledTimes(3)
  expect(result.current.error).toBe('')
})

test('隐藏后不读取，恢复补读；卸载后不再订阅', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const { rerender, unmount } = renderHook(
    ({ enabled }) => useTurnChanges(f.host, f.session, f.chat, enabled, f.onEvent, 'key'),
    { initialProps: { enabled: true } },
  )
  await act(async () => {})
  expect(f.summaries).toHaveBeenCalledTimes(1)
  rerender({ enabled: false })
  await act(async () => {
    f.event()
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(f.summaries).toHaveBeenCalledTimes(1)
  rerender({ enabled: true })
  await act(async () => {})
  expect(f.summaries).toHaveBeenCalledTimes(2)
  unmount()
  await act(async () => {
    f.event()
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(f.summaries).toHaveBeenCalledTimes(2)
})

test('读取途中消息范围变化也串行刷新，旧范围结果不能覆盖新范围', async () => {
  const f = fixture()
  let finish!: (value: unknown[]) => void
  f.summaries.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const { rerender } = renderHook(({ chat }) => useTurnChanges(f.host, f.session, chat, true, f.onEvent, 'key'), {
    initialProps: { chat: f.chat },
  })
  await act(async () => {})
  expect(f.summaries).toHaveBeenCalledTimes(1)
  rerender({
    chat: {
      ...f.chat,
      messages: [
        ...f.chat.messages,
        { ...f.chat.messages[0], sourceEntry: { id: 'v', type: 'message', revision: '1' } },
      ],
    },
  })
  await act(async () => {})
  expect(f.summaries).toHaveBeenCalledTimes(1)
  await act(async () => {
    finish([])
  })
  expect(f.summaries).toHaveBeenCalledTimes(2)
  expect(f.summaries.mock.calls[1][1]).toEqual(['u', 'v'])
})

test('首次摘要读取失败后不轮询，下一次事件重新读取完整范围', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.chat.messages.push({ ...f.chat.messages[0], sourceEntry: { id: 'v', type: 'message', revision: '1' } })
  f.summaries.mockRejectedValueOnce(new Error('读取失败'))
  const { result } = renderHook(() => useTurnChanges(f.host, f.session, f.chat, true, f.onEvent, 'key'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000)
  })
  expect(f.summaries).toHaveBeenCalledTimes(1)
  expect(result.current.error).toContain('读取失败')
  await act(async () => {
    f.event()
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(f.summaries.mock.calls[1][1]).toEqual(['u', 'v'])
  expect(result.current.error).toBe('')
})
