import * as React from 'react'
import type { ChatState } from '../model/types'

type ScrollPosition = { top: number; atBottom: boolean }

// 距离底部小于等于 80px 判定为处于底部
const BOTTOM_THRESHOLD = 80
// 内容总溢出高度（scrollHeight - clientHeight）必须超过 100px 才视为内容已铺开并具有有效滚动空间
const MIN_SCROLLABLE_OVERFLOW = 100

// 按会话保留滚动位置，切换会话后恢复，避免从旧位置跳到新会话底部。
const positions = new Map<string, ScrollPosition>()

export function useConversationScroll(
  chat: Pick<
    ChatState,
    'messages' | 'sessionEntries' | 'live' | 'tools' | 'agents' | 'agentMessages' | 'retry' | 'compactionError'
  >,
  sessionKey?: string,
  history?: { hasMore: boolean; loading: boolean; load: () => Promise<boolean> },
) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const isAtBottomRef = React.useRef(true)
  const activeSession = React.useRef<string | undefined>(undefined)
  const [showScrollTop, setShowScrollTop] = React.useState(false)
  const [showScrollBottom, setShowScrollBottom] = React.useState(false)
  const historyRequest = React.useRef<object | undefined>(undefined)
  const historyFrame = React.useRef(0)
  const anchor = React.useRef<{ element: HTMLElement; offset: number } | undefined>(undefined)
  const previousTop = React.useRef(0)
  const upwardIntent = React.useRef(false)
  const captureAnchor = React.useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const top = container.getBoundingClientRect().top
    const element = Array.from(container.querySelectorAll<HTMLElement>('[data-conversation-turn]')).find(
      (item) => item.getBoundingClientRect().bottom > top,
    )
    anchor.current = element ? { element, offset: element.getBoundingClientRect().top - top } : undefined
  }, [])
  const restoreAnchor = React.useCallback(() => {
    const container = containerRef.current
    const saved = anchor.current
    if (!container || !saved?.element.isConnected || !container.contains(saved.element)) return
    const delta = saved.element.getBoundingClientRect().top - container.getBoundingClientRect().top - saved.offset
    if (Math.abs(delta) > 0.5) container.scrollTop += delta
    previousTop.current = container.scrollTop
  }, [])
  const historyOptions = React.useRef(history)
  historyOptions.current = history
  const loadHistory = React.useCallback(async () => {
    const history = historyOptions.current
    if (!history?.hasMore || history.loading || historyRequest.current) return
    const request = {}
    historyRequest.current = request
    upwardIntent.current = false
    isAtBottomRef.current = false
    captureAnchor()
    try {
      await history.load()
    } finally {
      // 等前插内容完成布局后再允许下一次用户动作触发，滚动补偿本身不加载下一页。
      if (historyRequest.current === request) {
        historyFrame.current = requestAnimationFrame(() => {
          if (historyRequest.current !== request) return
          restoreAnchor()
          historyRequest.current = undefined
        })
      }
    }
  }, [captureAnchor, restoreAnchor])

  React.useLayoutEffect(() => {
    restoreAnchor()
  })

  React.useLayoutEffect(
    () => () => {
      cancelAnimationFrame(historyFrame.current)
      historyRequest.current = undefined
      anchor.current = undefined
      upwardIntent.current = false
    },
    [sessionKey],
  )

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let touchY: number | undefined
    const intend = (up: boolean) => {
      upwardIntent.current = up && !historyRequest.current
      if (upwardIntent.current && container.scrollTop <= 120) void loadHistory()
    }
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) intend(event.deltaY < 0)
    }
    const touchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY
    }
    const touchMove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY
      if (next !== undefined && touchY !== undefined) intend(next > touchY)
      touchY = next
    }
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, [contenteditable="true"]') || event.defaultPrevented) return
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) intend(true)
      else upwardIntent.current = false
    }
    const pointerDown = () => {
      upwardIntent.current = !historyRequest.current
    }
    container.addEventListener('wheel', wheel, { passive: true })
    container.addEventListener('touchstart', touchStart, { passive: true })
    container.addEventListener('touchmove', touchMove, { passive: true })
    container.addEventListener('keydown', keyDown)
    container.addEventListener('pointerdown', pointerDown)
    return () => {
      container.removeEventListener('wheel', wheel)
      container.removeEventListener('touchstart', touchStart)
      container.removeEventListener('touchmove', touchMove)
      container.removeEventListener('keydown', keyDown)
      container.removeEventListener('pointerdown', pointerDown)
    }
  }, [loadHistory])

  // 统一评估当前容器的滚动状态与回到底部箭头的可见性
  const updateScrollState = React.useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const overflow = el.scrollHeight - el.clientHeight
    const canScroll = overflow > MIN_SCROLLABLE_OVERFLOW
    const distanceToBottom = Math.max(0, overflow - el.scrollTop)
    const atBottom = !historyRequest.current && (!canScroll || distanceToBottom <= BOTTOM_THRESHOLD)

    isAtBottomRef.current = atBottom
    setShowScrollTop(el.scrollTop > 1)
    if (activeSession.current) {
      positions.delete(activeSession.current)
      positions.set(activeSession.current, { top: el.scrollTop, atBottom })
      if (positions.size > 200) positions.delete(positions.keys().next().value!)
    }
    setShowScrollBottom(canScroll && !atBottom)
  }, [])

  // 监听用户滚动位置
  const handleScroll = React.useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const movingUp = container.scrollTop < previousTop.current
    previousTop.current = container.scrollTop
    if (anchor.current) captureAnchor()
    updateScrollState()
    if (movingUp && upwardIntent.current && container.scrollTop <= 120) void loadHistory()
  }, [captureAnchor, loadHistory, updateScrollState])

  // 切换会话或重新挂载时恢复位置：贴底或未铺开的会话直接到底，其他会话在消息窗口稳定后再定位。
  React.useLayoutEffect(() => {
    if (activeSession.current === sessionKey) return
    activeSession.current = sessionKey
    upwardIntent.current = false
    anchor.current = undefined
    const el = containerRef.current
    if (!el) return
    const saved = sessionKey ? positions.get(sessionKey) : undefined
    const overflow = el.scrollHeight - el.clientHeight
    const canScroll = overflow > MIN_SCROLLABLE_OVERFLOW

    if (!saved || saved.atBottom || !canScroll) {
      isAtBottomRef.current = true
      el.scrollTop = el.scrollHeight
      previousTop.current = el.scrollTop
      setShowScrollTop(el.scrollTop > 1)
      setShowScrollBottom(false)
      return
    }
    isAtBottomRef.current = false
    setShowScrollBottom(true)
    // 可见轮次和滚动位置都在同一次渲染中恢复，下一帧再校准一次，避免布局未完成时被 clamp。
    el.scrollTop = saved.top
    previousTop.current = el.scrollTop
    setShowScrollTop(el.scrollTop > 1)
    const frame = requestAnimationFrame(() => {
      const target = containerRef.current
      if (!target) return
      target.scrollTop = saved.top
      previousTop.current = target.scrollTop
      updateScrollState()
    })
    return () => cancelAnimationFrame(frame)
  }, [sessionKey, updateScrollState])

  // 流式输出与新消息更新时：仅当处于底部时智能跟进滚动
  React.useEffect(() => {
    const container = containerRef.current
    if (container && isAtBottomRef.current) {
      // 只滚动消息区，避免 scrollIntoView 连带移动侧栏所在的祖先容器。
      container.scrollTop = container.scrollHeight
      updateScrollState()
    }
  }, [
    chat.messages,
    chat.sessionEntries,
    chat.live,
    chat.tools,
    chat.agents,
    chat.agentMessages,
    chat.retry,
    chat.compactionError,
    updateScrollState,
  ])

  // 监听容器及内部尺寸变化（如流式新增、折叠展开）：若处于吸底状态则跟进吸底，并实时更新箭头可见性
  React.useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const onResize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const target = containerRef.current
        if (!target) return
        if (isAtBottomRef.current) {
          target.scrollTop = target.scrollHeight
        } else restoreAnchor()
        updateScrollState()
      })
    }
    const observer = new ResizeObserver(onResize)
    observer.observe(container)
    if (container.firstElementChild) observer.observe(container.firstElementChild)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [restoreAnchor, updateScrollState])

  // 手动点击回到底部
  const scrollToBottom = React.useCallback(() => {
    const container = containerRef.current
    if (!container) return
    upwardIntent.current = false
    anchor.current = undefined
    container.scrollTo({
      top: container.scrollHeight,
      behavior: document.documentElement.dataset.reducedMotion === 'true' ? 'instant' : 'smooth',
    })
    isAtBottomRef.current = true
    setShowScrollBottom(false)
  }, [])

  // 定位到指定消息元素：若元素未就绪或容器不可滚动，绝不触发不在底部状态
  const scrollToMessage = React.useCallback((element?: HTMLElement) => {
    if (!element) return
    const container = containerRef.current
    if (!container) return
    upwardIntent.current = false
    anchor.current = undefined
    const overflow = container.scrollHeight - container.clientHeight
    if (overflow <= MIN_SCROLLABLE_OVERFLOW) {
      isAtBottomRef.current = true
      setShowScrollBottom(false)
      return
    }
    isAtBottomRef.current = false
    setShowScrollBottom(true)
    container.scrollTo({
      top: container.scrollTop + element.getBoundingClientRect().top - container.getBoundingClientRect().top - 24,
      behavior: document.documentElement.dataset.reducedMotion === 'true' ? 'instant' : 'smooth',
    })
  }, [])

  // 活动项折叠/展开回调：如果处于底部保持吸底，并校准滚动状态，绝不误触跳转逻辑
  const handleActivityToggle = React.useCallback(() => {
    requestAnimationFrame(() => {
      const container = containerRef.current
      if (!container) return
      if (isAtBottomRef.current) {
        container.scrollTop = container.scrollHeight
      }
      updateScrollState()
    })
  }, [updateScrollState])

  return {
    containerRef,
    showScrollTop,
    showScrollBottom,
    handleScroll,
    scrollToBottom,
    scrollToMessage,
    handleActivityToggle,
    loadHistory,
  }
}
