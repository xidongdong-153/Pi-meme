import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RetainedConversations } from '../src/session/retained-conversations'
import { emptyChat } from '@pi-meme/chat/ui/model/state'
import { ChatStream } from '@pi-meme/chat/ui/model/chat-stream'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { userMessage } from '../../../tests/fixtures/messages.mjs'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('切回最近会话复用 DOM 并回到底部，临时隐藏保留阅读位置且最多保留三个', () => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(3000)
  const chats = new Map(
    ['a', 'b', 'c', 'd'].map((key) => [key, { ...emptyChat, messages: [userMessage(`问题${key}`, 1)] }]),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  )
  const streams = new Map([...chats].map(([key, chat]) => [key, new ChatStream(chat)]))
  let subscriptions = 0
  const originalSubscribe = streams.get('a')!.subscribe
  streams.get('a')!.subscribe = (listener) => {
    subscriptions++
    const dispose = originalSubscribe(listener)
    return () => {
      subscriptions--
      dispose()
    }
  }
  const props = {
    hostId: 'host',
    active: true,
    canEditMessages: false,
    onEditMessage: () => {},
    onForkReply: () => {},
    onCopyError: () => {},
    getCachedChat: (key: string) => chats.get(key),
  }
  const conversation = (key: string) => (
    <TooltipProvider>
      <RetainedConversations {...props} sessionKey={key} chat={chats.get(key)!} stream={streams.get(key)} />
    </TooltipProvider>
  )
  const view = render(conversation('a'))
  const original = screen.getByText('问题a')
  const scroller = view.container.querySelector('[aria-label="对话消息流"]') as HTMLDivElement
  expect(scroller.scrollTop).toBe(3000)
  scroller.scrollTop = 200
  fireEvent.scroll(scroller)
  expect(subscriptions).toBe(1)
  view.rerender(conversation('b'))
  expect(original.isConnected).toBe(true)
  expect(subscriptions).toBe(0)
  view.rerender(conversation('a'))
  expect(screen.getByText('问题a')).toBe(original)
  expect(scroller.scrollTop).toBe(3000)
  scroller.scrollTop = 200
  fireEvent.scroll(scroller)
  view.rerender(
    <TooltipProvider>
      <RetainedConversations
        {...props}
        active={false}
        sessionKey="a"
        chat={chats.get('a')!}
        stream={streams.get('a')}
      />
    </TooltipProvider>,
  )
  view.rerender(conversation('a'))
  expect(scroller.scrollTop).toBe(200)
  view.rerender(
    <TooltipProvider>
      <RetainedConversations {...props} active={false} sessionKey="empty" chat={emptyChat} />
    </TooltipProvider>,
  )
  expect(original.isConnected).toBe(true)
  expect(subscriptions).toBe(0)
  view.rerender(conversation('a'))
  expect(screen.getByText('问题a')).toBe(original)
  expect(scroller.scrollTop).toBe(3000)
  scroller.scrollTop = 200
  fireEvent.scroll(scroller)
  view.rerender(conversation('b'))
  view.rerender(conversation('c'))
  view.rerender(conversation('d'))
  expect(view.container.querySelectorAll('[data-session-pane]')).toHaveLength(3)
  expect(original.isConnected).toBe(false)
  view.rerender(conversation('a'))
  const restoredScroller = view.container.querySelector('[aria-label="对话消息流"]') as HTMLDivElement
  expect(restoredScroller.scrollTop).toBe(3000)
  restoredScroller.scrollTop = 200
  fireEvent.scroll(restoredScroller)
  view.unmount()
  const refreshed = render(conversation('a'))
  expect(refreshed.container.querySelector('[aria-label="对话消息流"]')!.scrollTop).toBe(200)
})
