import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { HomeFlyoutControl } from './app-rail'

/** 会话菜单、重命名和删除对话框都渲染在 body 上，指针进入这些浮层不算离开会话栏。 */
const overlaySelector = '[data-radix-popper-content-wrapper], [role="dialog"]'

const openDelay = 120
const closeDelay = 200
/** 面板退场动画是 `duration-150`，多等一点再卸载，避免截掉最后一帧。 */
const exitDuration = 190

/**
 * 折叠态首页的悬停会话浮层。
 * 只在固定会话栏收起后启用，浮层盖在聊天区上，不改变保存的侧栏宽度。
 */
export function useSidebarFlyout({ enabled, reduceMotion }: { enabled: boolean; reduceMotion: boolean }): {
  visible: boolean
  mounted: boolean
  control: HomeFlyoutControl
  panelRef: RefObject<HTMLDivElement | null>
  panelProps: { onPointerEnter: () => void; onPointerLeave: () => void }
  close: () => void
} {
  const [requested, setRequested] = useState(false)
  const visible = requested && enabled
  // 关闭时保留一帧完成退场动画，否则元素一卸载就没有过渡。
  const [mounted, setMounted] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
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
    if (!enabled) setRequested(false)
  }, [enabled])

  useEffect(() => {
    if (!requested) pinned.current = false
  }, [requested])

  useEffect(() => {
    if (!visible) return
    const overlayOpen = () => Boolean(document.querySelector(overlaySelector))
    const inside = (target: EventTarget | null) =>
      target instanceof Element &&
      (Boolean(panelRef.current?.contains(target)) ||
        Boolean(target.closest('[data-home-trigger]')) ||
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
      document.querySelector<HTMLElement>('[data-home-trigger]')?.focus()
    }
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [visible, clearTimer, schedule, close])

  useEffect(() => {
    if (!visible || !mounted || !focusOnOpen.current) return
    focusOnOpen.current = false
    panelRef.current
      ?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      ?.focus()
  }, [visible, mounted])

  const control: HomeFlyoutControl = {
    open: visible,
    onPointerEnter: () => {
      if (enabled) schedule(true)
    },
    onPointerLeave: () => {
      if (!pinned.current) schedule(false)
    },
    onKeyboardOpen: () => {
      if (!enabled) return
      focusOnOpen.current = true
      pinned.current = true
      clearTimer()
      setRequested(true)
    },
  }

  return {
    visible,
    mounted,
    control,
    panelRef,
    panelProps: {
      onPointerEnter: () => {
        pinned.current = false
        clearTimer()
      },
      onPointerLeave: () => {
        if (!pinned.current) schedule(false)
      },
    },
    close,
  }
}
