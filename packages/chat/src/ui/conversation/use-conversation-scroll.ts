import * as React from 'react'
import type { ChatState } from '../model/types'

type ScrollPosition = { top: number; atBottom: boolean }

// 按会话保留滚动位置，切换会话后恢复，避免从旧位置跳到新会话底部。
const positions = new Map<string, ScrollPosition>()

export function useConversationScroll(
  chat: Pick<ChatState, 'messages' | 'live' | 'tools' | 'agents' | 'agentMessages' | 'retry' | 'compactionError'>,
  sessionKey?: string,
) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const bottomRef = React.useRef<HTMLDivElement>(null)
  const isAtBottomRef = React.useRef(true)
  const isJumpingRef = React.useRef(false)
  const activeSession = React.useRef<string | undefined>(undefined)
  const [showScrollBottom, setShowScrollBottom] = React.useState(false)

  // 监听滚动位置，判断是否处于底部
  const handleScroll = React.useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distanceToBottom <= 80
    if (!atBottom) isJumpingRef.current = false
    isAtBottomRef.current = atBottom && !isJumpingRef.current
    if (activeSession.current) {
      positions.delete(activeSession.current)
      positions.set(activeSession.current, { top: el.scrollTop, atBottom: isAtBottomRef.current })
      if (positions.size > 200) positions.delete(positions.keys().next().value!)
    }
    setShowScrollBottom(!isAtBottomRef.current)
  }, [])

  // 切换会话或重新挂载时恢复位置：贴底的会话直接到底，其他会话在消息窗口稳定后再定位。
  React.useLayoutEffect(() => {
    if (activeSession.current === sessionKey) return
    activeSession.current = sessionKey
    const el = containerRef.current
    if (!el) return
    const saved = sessionKey ? positions.get(sessionKey) : undefined
    if (!saved || saved.atBottom) {
      isAtBottomRef.current = true
      isJumpingRef.current = false
      el.scrollTop = el.scrollHeight
      setShowScrollBottom(false)
      return
    }
    isAtBottomRef.current = false
    isJumpingRef.current = false
    setShowScrollBottom(true)
    // 可见轮次和滚动位置都在同一次渲染中恢复，下一帧再校准一次，避免布局未完成时被 clamp。
    el.scrollTop = saved.top
    const frame = requestAnimationFrame(() => {
      const target = containerRef.current
      if (!target) return
      target.scrollTop = saved.top
      const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight
      isAtBottomRef.current = distanceToBottom <= 80
      setShowScrollBottom(!isAtBottomRef.current)
    })
    return () => cancelAnimationFrame(frame)
  }, [sessionKey])

  // 流式输出与新消息更新时：仅当处于底部时智能跟进滚动
  React.useEffect(() => {
    if (isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' })
    }
  }, [chat.messages, chat.live, chat.tools, chat.agents, chat.agentMessages, chat.retry, chat.compactionError])

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
