import { cleanup, render, screen } from '@testing-library/react'
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

test('切回最近会话复用 DOM，隐藏面板退订当前聊天流且最多保留三个', () => {
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
  expect(subscriptions).toBe(1)
  view.rerender(conversation('b'))
  expect(original.isConnected).toBe(true)
  expect(subscriptions).toBe(0)
  view.rerender(conversation('a'))
  expect(screen.getByText('问题a')).toBe(original)
  view.rerender(
    <TooltipProvider>
      <RetainedConversations {...props} active={false} sessionKey="empty" chat={emptyChat} />
    </TooltipProvider>,
  )
  expect(original.isConnected).toBe(true)
  expect(subscriptions).toBe(0)
  view.rerender(conversation('a'))
  expect(screen.getByText('问题a')).toBe(original)
  view.rerender(conversation('b'))
  view.rerender(conversation('c'))
  view.rerender(conversation('d'))
  expect(view.container.querySelectorAll('[data-session-pane]')).toHaveLength(3)
  expect(original.isConnected).toBe(false)
})
