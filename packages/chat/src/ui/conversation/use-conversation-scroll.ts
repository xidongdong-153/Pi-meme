import * as React from 'react'

type ScrollPosition = { top: number; atBottom: boolean; turn?: string; offset?: number }

// 距离底部小于等于 80px 判定为处于底部
const BOTTOM_THRESHOLD = 80
// 内容总溢出高度（scrollHeight - clientHeight）必须超过 100px 才视为内容已铺开并具有有效滚动空间
const MIN_SCROLLABLE_OVERFLOW = 100

// 按会话保留阅读位置，刷新界面时恢复。
const positions = new Map<string, ScrollPosition>()

export function useConversationScroll(
  sessionKey?: string,
  history?: { hasMore: boolean; loading: boolean; load: () => Promise<boolean> },
  scrollResetVersion = 0,
  scrollToBottomVersion = 0,
) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  // 跟随意图独立于当前几何距离，内容增高和程序滚动不能取消跟随。
  const followBottomRef = React.useRef(true)
  const previousBottomVersion = React.useRef(scrollToBottomVersion)
  const activeSession = React.useRef<string | undefined>(undefined)
  const previousResetVersion = React.useRef<number | undefined>(undefined)
  const [showScrollTop, setShowScrollTop] = React.useState(false)
  const [showScrollBottom, setShowScrollBottom] = React.useState(false)
  const historyRequest = React.useRef<object | undefined>(undefined)
  const historyFrame = React.useRef(0)
  const restoreFrame = React.useRef(0)
  const anchor = React.useRef<{ element: HTMLElement; offset: number } | undefined>(undefined)
  const pendingRestore = React.useRef<ScrollPosition | undefined>(undefined)
  const restoreLoading = React.useRef<object | undefined>(undefined)
  const [, retryRestore] = React.useReducer((value: number) => value + 1, 0)
  const previousTop = React.useRef(0)
  const upwardIntent = React.useRef(false)
  const cancelRestore = React.useCallback(() => {
    cancelAnimationFrame(historyFrame.current)
    cancelAnimationFrame(restoreFrame.current)
    historyRequest.current = undefined
    anchor.current = undefined
    pendingRestore.current = undefined
    restoreLoading.current = undefined
    upwardIntent.current = false
  }, [])
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
    followBottomRef.current = false
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

  React.useLayoutEffect(() => cancelRestore, [sessionKey, cancelRestore])

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let touchY: number | undefined
    const intend = (up: boolean) => {
      upwardIntent.current = up && !historyRequest.current
      if (up && followBottomRef.current && container.scrollTop > 0) {
        followBottomRef.current = false
        // 用户向上阅读时立即停止尚未结束的平滑回底。
        container.scrollTo({ top: container.scrollTop, behavior: 'instant' })
      }
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
      else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) intend(false)
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
    if (!el || pendingRestore.current) return
    const overflow = el.scrollHeight - el.clientHeight
    const canScroll = overflow > MIN_SCROLLABLE_OVERFLOW
    const distanceToBottom = Math.max(0, overflow - el.scrollTop)
    const atBottom =
      !historyRequest.current && (followBottomRef.current || !canScroll || distanceToBottom <= BOTTOM_THRESHOLD)

    setShowScrollTop(el.scrollTop > 1)
    if (activeSession.current) {
      const previous = positions.get(activeSession.current)
      // 贴底恢复不需要历史锚点，流式增高也不改变这份阅读状态。
      if (!atBottom || !previous?.atBottom) {
        const top = atBottom ? 0 : el.getBoundingClientRect().top
        const turn = atBottom
          ? undefined
          : [...el.querySelectorAll<HTMLElement>('[data-conversation-turn]')].find(
              (item) => item.getBoundingClientRect().bottom > top,
            )
        const saved = {
          top: atBottom ? 0 : el.scrollTop,
          atBottom,
          turn: turn?.dataset.conversationTurn,
          offset: turn ? turn.getBoundingClientRect().top - top : undefined,
        }
        positions.delete(activeSession.current)
        positions.set(activeSession.current, saved)
        if (
          previous?.top !== saved.top ||
          previous.atBottom !== saved.atBottom ||
          previous.turn !== saved.turn ||
          previous.offset !== saved.offset
        ) {
          try {
            sessionStorage.setItem(`pi-meme:reading:v1:${activeSession.current}`, JSON.stringify(saved))
          } catch {
            /* 存储不可用时仍保留内存位置。 */
          }
        }
        if (positions.size > 200) positions.delete(positions.keys().next().value!)
      }
    }
    setShowScrollBottom(canScroll && !atBottom)
  }, [])

  // 监听用户滚动位置
  const handleScroll = React.useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const movingUp = container.scrollTop < previousTop.current
    previousTop.current = container.scrollTop
    const distanceToBottom = Math.max(0, container.scrollHeight - container.clientHeight - container.scrollTop)
    if (!pendingRestore.current && !historyRequest.current) {
      if (movingUp && upwardIntent.current && distanceToBottom > BOTTOM_THRESHOLD) followBottomRef.current = false
      else if (distanceToBottom <= 1 || (!upwardIntent.current && distanceToBottom <= BOTTOM_THRESHOLD))
        followBottomRef.current = true
    }
    if (anchor.current) captureAnchor()
    updateScrollState()
    if (movingUp && upwardIntent.current && container.scrollTop <= 120) void loadHistory()
  }, [captureAnchor, loadHistory, updateScrollState])

  // 首次挂载恢复刷新前的阅读位置；切换会话时回到底部，临时隐藏同一会话时保留位置。
  React.useLayoutEffect(() => {
    if (activeSession.current === sessionKey && previousResetVersion.current === scrollResetVersion) return
    const restoreSaved = previousResetVersion.current === undefined && scrollResetVersion === 0
    activeSession.current = sessionKey
    previousResetVersion.current = scrollResetVersion
    cancelRestore()
    const el = containerRef.current
    if (!el) return
    let saved = restoreSaved && sessionKey ? positions.get(sessionKey) : undefined
    if (!saved && restoreSaved && sessionKey) {
      try {
        const value = JSON.parse(sessionStorage.getItem(`pi-meme:reading:v1:${sessionKey}`) ?? 'null')
        if (value && Number.isFinite(value.top) && typeof value.atBottom === 'boolean') saved = value
      } catch {
        /* 损坏的阅读记录不影响打开会话。 */
      }
    }
    const overflow = el.scrollHeight - el.clientHeight
    const canScroll = overflow > MIN_SCROLLABLE_OVERFLOW

    if (
      saved &&
      !saved.atBottom &&
      saved.turn &&
      ![...el.querySelectorAll<HTMLElement>('[data-conversation-turn]')].some(
        (item) => item.dataset.conversationTurn === saved.turn,
      ) &&
      historyOptions.current?.hasMore
    ) {
      pendingRestore.current = saved
      followBottomRef.current = false
      return
    }
    if (!saved || saved.atBottom || !canScroll) {
      followBottomRef.current = true
      el.scrollTop = el.scrollHeight
      previousTop.current = el.scrollTop
      setShowScrollTop(el.scrollTop > 1)
      setShowScrollBottom(false)
      return
    }
    followBottomRef.current = false
    setShowScrollBottom(true)
    // 可见轮次和滚动位置都在同一次渲染中恢复，下一帧再校准一次，避免布局未完成时被 clamp。
    el.scrollTop = saved.top
    previousTop.current = el.scrollTop
    setShowScrollTop(el.scrollTop > 1)
    const frame = requestAnimationFrame(() => {
      const target = containerRef.current
      if (!target) return
      const turn = saved.turn
        ? [...target.querySelectorAll<HTMLElement>('[data-conversation-turn]')].find(
            (item) => item.dataset.conversationTurn === saved.turn,
          )
        : undefined
      target.scrollTop =
        turn && typeof saved.offset === 'number'
          ? target.scrollTop + turn.getBoundingClientRect().top - target.getBoundingClientRect().top - saved.offset
          : saved.top
      previousTop.current = target.scrollTop
      updateScrollState()
    })
    restoreFrame.current = frame
    return () => cancelAnimationFrame(frame)
  }, [sessionKey, scrollResetVersion, cancelRestore, updateScrollState])

  React.useLayoutEffect(() => {
    const saved = pendingRestore.current
    const container = containerRef.current
    if (!saved || !container || restoreLoading.current) return
    const turn = [...container.querySelectorAll<HTMLElement>('[data-conversation-turn]')].find(
      (item) => item.dataset.conversationTurn === saved.turn,
    )
    const history = historyOptions.current
    if (turn || !history?.hasMore) {
      pendingRestore.current = undefined
      container.scrollTop =
        turn && typeof saved.offset === 'number'
          ? container.scrollTop +
            turn.getBoundingClientRect().top -
            container.getBoundingClientRect().top -
            saved.offset
          : saved.top
      previousTop.current = container.scrollTop
      captureAnchor()
      updateScrollState()
    } else if (!history.loading) {
      const owner = activeSession.current
      const request = {}
      restoreLoading.current = request
      const owns = () => activeSession.current === owner && restoreLoading.current === request
      void history
        .load()
        .then((loaded) => {
          if (!loaded && owns()) pendingRestore.current = undefined
        })
        .catch(() => {
          if (owns()) pendingRestore.current = undefined
        })
        .finally(() => {
          if (owns()) {
            restoreLoading.current = undefined
            // 历史提交之后再恢复；不会在另一会话继续加载。
            historyFrame.current = requestAnimationFrame(() => {
              if (activeSession.current === owner) retryRestore()
            })
          }
        })
    }
  })

  const followLatest = React.useCallback(
    (behavior: ScrollBehavior) => {
      const container = containerRef.current
      if (!container) return
      cancelRestore()
      followBottomRef.current = true
      container.scrollTo({ top: container.scrollHeight, behavior })
      previousTop.current = container.scrollTop
      updateScrollState()
    },
    [cancelRestore, updateScrollState],
  )

  // 只有本窗口的真实发送请求触发回底；历史补读和其他窗口的新消息保留阅读位置。
  React.useLayoutEffect(() => {
    if (previousBottomVersion.current === scrollToBottomVersion) return
    previousBottomVersion.current = scrollToBottomVersion
    if (scrollToBottomVersion) followLatest('instant')
  }, [scrollToBottomVersion, followLatest])

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
        if (followBottomRef.current) {
          target.scrollTop = target.scrollHeight
          previousTop.current = target.scrollTop
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
    followLatest(document.documentElement.dataset.reducedMotion === 'true' ? 'instant' : 'smooth')
  }, [followLatest])

  // 定位到指定消息元素：若元素未就绪或容器不可滚动，绝不触发不在底部状态
  const scrollToMessage = React.useCallback(
    (element?: HTMLElement) => {
      if (!element) return
      const container = containerRef.current
      if (!container) return
      cancelRestore()
      const overflow = container.scrollHeight - container.clientHeight
      if (overflow <= MIN_SCROLLABLE_OVERFLOW) {
        followBottomRef.current = true
        setShowScrollBottom(false)
        return
      }
      followBottomRef.current = false
      setShowScrollBottom(true)
      container.scrollTo({
        top: container.scrollTop + element.getBoundingClientRect().top - container.getBoundingClientRect().top - 24,
        behavior: document.documentElement.dataset.reducedMotion === 'true' ? 'instant' : 'smooth',
      })
    },
    [cancelRestore],
  )

  // 活动项折叠/展开回调：如果处于底部保持吸底，并校准滚动状态，绝不误触跳转逻辑
  const handleActivityToggle = React.useCallback(() => {
    requestAnimationFrame(() => {
      const container = containerRef.current
      if (!container) return
      if (followBottomRef.current) {
        container.scrollTop = container.scrollHeight
        previousTop.current = container.scrollTop
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
