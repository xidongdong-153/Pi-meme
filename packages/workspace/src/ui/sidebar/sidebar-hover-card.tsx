import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@pi-meme/ui/components/ui/popover'

const openEvent = 'pi:sidebar-hover-card-open'
const openDelay = 300
const closeDelay = 180
const actionSelector = '[data-sidebar-drag-ignore], [data-tooltip-trigger], [aria-haspopup="menu"]'

/** 行与卡片共用悬停范围，穿过间隙时保留卡片；列表操作和隐藏立即关闭。 */
export function SidebarHoverCard({
  children,
  label,
  content,
}: {
  children: ReactNode
  label: string
  content: (close: () => void) => ReactNode
}) {
  const id = useId()
  const [phase, setPhase] = useState<'closed' | 'pending' | 'open'>('closed')
  const open = phase === 'open'
  const anchor = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dismissed = useRef(false)

  const clearTimers = useCallback(() => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
    openTimer.current = undefined
    closeTimer.current = undefined
  }, [])
  const hide = useCallback(() => {
    clearTimers()
    setPhase('closed')
  }, [clearTimers])
  const close = useCallback(() => {
    dismissed.current = true
    hide()
  }, [hide])
  const anchorVisible = useCallback(() => {
    const element = anchor.current
    return Boolean(
      element?.isConnected &&
      element.getClientRects().length &&
      !element.closest('[inert], [aria-hidden="true"], [hidden]'),
    )
  }, [])
  const show = useCallback(() => {
    clearTimers()
    if (!anchorVisible()) {
      hide()
      return
    }
    dismissed.current = false
    document.dispatchEvent(new CustomEvent(openEvent, { detail: id }))
    setPhase('open')
  }, [anchorVisible, clearTimers, hide, id])
  const scheduleOpen = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = undefined
    if (open || openTimer.current !== undefined || dismissed.current) return
    setPhase('pending')
    openTimer.current = setTimeout(show, openDelay)
  }
  const scheduleClose = () => {
    clearTimers()
    closeTimer.current = setTimeout(() => {
      closeTimer.current = undefined
      const focus = document.activeElement
      if (focus?.matches(':focus-visible') && (anchor.current?.contains(focus) || panel.current?.contains(focus)))
        return
      hide()
    }, closeDelay)
  }
  const returnFocus = () => anchor.current?.querySelector<HTMLButtonElement>('button')?.focus()

  useEffect(() => clearTimers, [clearTimers])
  useEffect(() => {
    if (phase === 'closed') return
    const onOtherOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) close()
    }
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) close()
    }
    const observer = new MutationObserver(() => {
      if (!anchorVisible()) close()
    })
    for (let element: HTMLElement | null = anchor.current; element; element = element.parentElement) {
      observer.observe(element, {
        attributes: true,
        attributeFilter: ['inert', 'aria-hidden', 'hidden', 'class', 'style'],
      })
    }
    document.addEventListener(openEvent, onOtherOpen)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('dragstart', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      observer.disconnect()
      document.removeEventListener(openEvent, onOtherOpen)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('dragstart', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [phase, anchorVisible, close, id])

  return (
    <Popover open={open} onOpenChange={(next) => (next ? show() : close())}>
      <PopoverAnchor asChild>
        <div
          ref={anchor}
          className="min-w-0"
          onPointerEnter={(event) => {
            if (event.pointerType === 'touch') return
            dismissed.current = false
            if (!(event.target instanceof Element) || !event.target.closest(actionSelector)) scheduleOpen()
          }}
          onPointerMoveCapture={(event) => {
            if (event.pointerType === 'touch' || !event.currentTarget.contains(event.target as Node)) return
            if (!open && event.target instanceof Element && event.target.closest(actionSelector)) hide()
            else scheduleOpen()
          }}
          onPointerLeave={scheduleClose}
          onPointerDownCapture={(event) => {
            if (event.currentTarget.contains(event.target as Node)) close()
          }}
          onContextMenuCapture={(event) => {
            if (event.currentTarget.contains(event.target as Node)) close()
          }}
          onFocusCapture={(event) => {
            if (
              event.target.matches(':focus-visible') &&
              event.currentTarget.contains(event.target) &&
              !event.target.closest(actionSelector)
            )
              scheduleOpen()
          }}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.target)) return
            if (event.currentTarget.contains(event.relatedTarget) || panel.current?.contains(event.relatedTarget))
              return
            dismissed.current = false
            hide()
          }}
          onKeyDownCapture={(event) => {
            if (!event.currentTarget.contains(event.target as Node)) return
            if (event.key === 'Escape') close()
            if (event.key === 'ArrowRight' && open) {
              event.preventDefault()
              event.stopPropagation()
              panel.current?.focus()
            }
          }}
        >
          {children}
        </div>
      </PopoverAnchor>
      <PopoverContent
        ref={panel}
        id={id}
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        aria-label={label}
        aria-hidden={!open || undefined}
        inert={!open}
        tabIndex={-1}
        className="w-[22rem] max-w-[min(22rem,var(--radix-popover-content-available-width),calc(100vw-24px))] max-h-[min(28rem,var(--radix-popover-content-available-height))] overflow-y-auto overscroll-contain rounded-xl bg-secondary p-3 text-xs shadow-lg select-text data-[state=closed]:pointer-events-none motion-reduce:animate-none"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={() => {
          dismissed.current = true
          if (panel.current?.contains(document.activeElement)) returnFocus()
        }}
        onPointerEnter={clearTimers}
        onPointerLeave={scheduleClose}
        onFocusCapture={clearTimers}
        onBlurCapture={(event) => {
          if (!panel.current?.contains(event.relatedTarget) && !anchor.current?.contains(event.relatedTarget)) close()
        }}
      >
        {content(close)}
      </PopoverContent>
    </Popover>
  )
}
