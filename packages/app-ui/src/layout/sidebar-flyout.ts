import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export type SidebarFlyoutControl = {
  open: boolean
  contentId: string
  triggerRef: RefObject<HTMLButtonElement | null>
  onPointerEnter: () => void
  onPointerLeave: () => void
  onKeyboardOpen: () => void
}

/** 会话菜单、重命名和删除对话框都渲染在 body 上，指针进入这些浮层不算离开会话栏。 */
const overlaySelector = '[data-radix-popper-content-wrapper], [role="dialog"]'

const openDelay = 120
const closeDelay = 200
/** 面板退场动画是 `duration-150`，多等一点再卸载，避免截掉最后一帧。 */
const exitDuration = 190

/** 固定侧栏完全收起后启用；浮层覆盖内容区，不改变客户端保存的开合和宽度。 */
export function useSidebarFlyout({
  enabled,
  ready = true,
  reduceMotion,
  contentId,
  toggleRef,
}: {
  enabled: boolean
  ready?: boolean
  reduceMotion: boolean
  contentId: string
  toggleRef: RefObject<HTMLButtonElement | null>
}): {
  open: boolean
  visible: boolean
  mounted: boolean
  control: SidebarFlyoutControl | undefined
  panelRef: RefObject<HTMLDivElement | null>
  panelProps: { onPointerEnter: () => void; onPointerLeave: () => void }
  close: () => void
} {
  const [requested, setRequested] = useState(false)
  const open = requested && enabled
  const visible = open && ready
  // 关闭时保留一帧完成退场动画，否则元素一卸载就没有过渡。
  const [mounted, setMounted] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLButtonElement | null>(null)
  const timer = useRef<number | null>(null)
  // 键盘打开后焦点在浮层里，不跟随指针位置收起。
  const pinned = useRef(false)
  const focusOnOpen = useRef(false)

  const clearTimer = useCallback(() => {
    if (timer.current === null) return
    window.clearTimeout(timer.current)
    timer.current = null
  }, [])

  const unmount = useCallback(() => setMounted(false), [])
  const focusPanel = useCallback(() => {
    panelRef.current
      ?.querySelector<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )
      ?.focus()
  }, [])

  useEffect(() => {
    if (visible) {
      setMounted(true)
      return
    }
    // 固定侧栏重新展开时立即让位，不和它叠在一起播退场。
    if (!enabled || reduceMotion) {
      setMounted(false)
      return
    }
    const timeout = window.setTimeout(unmount, exitDuration)
    return () => window.clearTimeout(timeout)
  }, [visible, enabled, reduceMotion, unmount])

  const schedule = useCallback(
    (open: boolean) => {
      clearTimer()
      timer.current = window.setTimeout(
        () => {
          timer.current = null
          if (!open && (pinned.current || panelRef.current?.contains(document.activeElement))) return
          setRequested(open)
        },
        open ? openDelay : closeDelay,
      )
    },
    [clearTimer],
  )

  const close = useCallback(() => {
    clearTimer()
    setRequested(false)
  }, [clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  useEffect(() => {
    if (!enabled) {
      clearTimer()
      focusOnOpen.current = false
      setRequested(false)
    }
  }, [enabled, clearTimer])

  useEffect(() => {
    if (!requested) pinned.current = false
  }, [requested])

  useEffect(() => {
    if (!visible) return
    const overlayOpen = () =>
      [...document.querySelectorAll(overlaySelector)].some(
        (element) => element.getClientRects().length > 0 && !element.querySelector('[role="tooltip"]'),
      )
    const inside = (target: EventTarget | null) =>
      target instanceof Element &&
      (Boolean(panelRef.current?.contains(target)) ||
        Boolean(triggerRef.current?.contains(target)) ||
        Boolean(toggleRef.current?.contains(target)) ||
        Boolean(target.closest(overlaySelector)))
    const onPointerMove = (event: PointerEvent) => {
      if (inside(event.target)) {
        clearTimer()
        return
      }
      // 菜单或对话框打开期间不收，避免卸载掉正在操作的浮层。
      if (pinned.current || overlayOpen() || timer.current !== null) return
      schedule(false)
    }
    const onPointerDown = (event: PointerEvent) => {
      if (inside(event.target)) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || overlayOpen()) return
      // 焦点在输入框等浮层外区域时，保留它们自己的 Escape 行为。
      const focus = document.activeElement
      if (focus !== null && focus !== document.body && !inside(focus)) return
      event.stopPropagation()
      close()
      const button = returnFocus.current ?? triggerRef.current
      button?.focus()
    }
    const onFocusIn = (event: FocusEvent) => {
      if (inside(event.target)) {
        clearTimer()
        if (
          panelRef.current?.contains(event.target as Node) ||
          (event.target instanceof Element && event.target.closest(overlaySelector))
        )
          pinned.current = true
      } else close()
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [visible, clearTimer, schedule, close, toggleRef])

  useEffect(() => {
    if (!visible || !mounted || !focusOnOpen.current) return
    focusOnOpen.current = false
    focusPanel()
  }, [visible, mounted, focusPanel])

  const control: SidebarFlyoutControl = {
    open,
    contentId,
    triggerRef,
    onPointerEnter: () => {
      if (enabled) schedule(true)
    },
    onPointerLeave: () => {
      if (!pinned.current) schedule(false)
    },
    onKeyboardOpen: () => {
      if (!enabled) return
      focusOnOpen.current = true
      returnFocus.current = document.activeElement === toggleRef.current ? toggleRef.current : triggerRef.current
      pinned.current = true
      clearTimer()
      setRequested(true)
      if (visible && mounted) {
        focusOnOpen.current = false
        focusPanel()
      }
    },
  }

  return {
    open,
    visible,
    mounted,
    control: enabled ? control : undefined,
    panelRef,
    panelProps: {
      onPointerEnter: clearTimer,
      onPointerLeave: () => {
        if (!pinned.current) schedule(false)
      },
    },
    close,
  }
}
