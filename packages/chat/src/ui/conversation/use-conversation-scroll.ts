import * as React from 'react'
import type { ChatState } from '../model/types'

export function useConversationScroll(chat: Pick<ChatState, 'messages' | 'live' | 'tools'>) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const bottomRef = React.useRef<HTMLDivElement>(null)
  const isAtBottomRef = React.useRef(true)
  const isJumpingRef = React.useRef(false)
  const [showScrollBottom, setShowScrollBottom] = React.useState(false)

  // 监听滚动位置，判断是否处于底部
  const handleScroll = React.useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distanceToBottom <= 80
    if (!atBottom) isJumpingRef.current = false
    isAtBottomRef.current = atBottom && !isJumpingRef.current
    setShowScrollBottom(!isAtBottomRef.current)
  }, [])

  // 流式输出与新消息更新时：仅当处于底部时智能跟进滚动
  React.useEffect(() => {
    if (isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' })
    }
  }, [chat.messages, chat.live, chat.tools])

  const scrollToBottom = React.useCallback(() => {
    isJumpingRef.current = false
    bottomRef.current?.scrollIntoView({
      behavior: document.documentElement.dataset.reducedMotion === 'true' ? 'instant' : 'smooth',
    })
    isAtBottomRef.current = true
    setShowScrollBottom(false)
  }, [])

  const scrollToMessage = React.useCallback((element?: HTMLElement) => {
    isJumpingRef.current = true
    isAtBottomRef.current = false
    setShowScrollBottom(true)
    const container = containerRef.current
    if (!container || !element) return
    container.scrollTo({
      top: container.scrollTop + element.getBoundingClientRect().top - container.getBoundingClientRect().top - 24,
      behavior: document.documentElement.dataset.reducedMotion === 'true' ? 'instant' : 'smooth',
    })
  }, [])

  return { containerRef, bottomRef, showScrollBottom, handleScroll, scrollToBottom, scrollToMessage }
}
