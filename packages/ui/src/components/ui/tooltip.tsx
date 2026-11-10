import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '../../lib/utils'

export const TooltipProvider = TooltipPrimitive.Provider
export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>((props, ref) => <TooltipPrimitive.Trigger ref={ref} data-tooltip-trigger="" {...props} />)
TooltipTrigger.displayName = TooltipPrimitive.Trigger.displayName

export const tooltipSurfaceClassName =
  'rounded-md border border-border bg-popover px-3 py-1.5 text-xs font-normal text-popover-foreground shadow-md'

export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, children, sideOffset = 4, collisionPadding = 12, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        tooltipSurfaceClassName,
        'z-50 max-w-[min(24rem,var(--radix-tooltip-content-available-width,calc(100vw-24px)),calc(100vw-24px))] max-h-[min(24rem,var(--radix-tooltip-content-available-height,calc(100dvh-24px)))] overflow-hidden whitespace-pre-line [overflow-wrap:anywhere] select-none pointer-events-none animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:fill-mode-forwards data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 motion-reduce:animate-none',
        className,
      )}
      {...props}
    >
      {typeof children === 'string' ? <span className="line-clamp-[12]">{children}</span> : children}
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

type TooltipPlacement = Pick<
  React.ComponentPropsWithoutRef<typeof TooltipContent>,
  'side' | 'align' | 'sideOffset' | 'collisionPadding'
>

type TooltipHintProps = Omit<
  React.ComponentPropsWithoutRef<typeof TooltipTrigger>,
  'children' | 'content' | 'asChild'
> &
  TooltipPlacement & {
    content: React.ReactNode
    children: React.ReactElement
    delayDuration?: number
    open?: boolean
  }

export const TooltipHint = React.forwardRef<React.ElementRef<typeof TooltipTrigger>, TooltipHintProps>(
  (
    {
      content,
      children,
      side,
      align,
      sideOffset,
      collisionPadding = 12,
      delayDuration,
      open,
      onPointerMoveCapture,
      onFocusCapture,
      ...props
    },
    ref,
  ) => {
    const [nested, setNested] = React.useState(false)
    const hasContent = content !== undefined && content !== null && content !== false && content !== ''
    const trackNested = (event: React.SyntheticEvent) => {
      const trigger = event.target instanceof Element ? event.target.closest('[data-tooltip-trigger]') : null
      setNested(!!trigger && trigger !== event.currentTarget)
    }
    return (
      <Tooltip open={hasContent && !nested ? open : false} delayDuration={delayDuration} disableHoverableContent>
        <TooltipTrigger
          asChild
          ref={ref}
          {...props}
          data-tooltip-trigger={hasContent ? '' : undefined}
          onPointerMoveCapture={(event) => {
            onPointerMoveCapture?.(event)
            trackNested(event)
          }}
          onFocusCapture={(event) => {
            onFocusCapture?.(event)
            trackNested(event)
          }}
        >
          {children}
        </TooltipTrigger>
        {hasContent && (
          <TooltipContent side={side} align={align} sideOffset={sideOffset} collisionPadding={collisionPadding}>
            {content}
          </TooltipContent>
        )}
      </Tooltip>
    )
  },
)
TooltipHint.displayName = 'TooltipHint'

/** Completes clipped text without repeating labels that already fit. */
export function OverflowTooltip({
  content,
  children,
  delayDuration,
  ...placement
}: TooltipPlacement & { content: string; children: React.ReactElement; delayDuration?: number }) {
  const trigger = React.useRef<React.ElementRef<typeof TooltipTrigger>>(null)
  const [requested, setRequested] = React.useState(false)
  const [truncated, setTruncated] = React.useState(false)
  const [focusParent, setFocusParent] = React.useState(false)
  const measure = React.useCallback(() => {
    const element = trigger.current
    const clipped = Boolean(
      element?.getClientRects().length && !element.closest('[inert]') && element.scrollWidth > element.clientWidth + 1,
    )
    setTruncated(clipped)
    return clipped
  }, [])

  React.useLayoutEffect(() => {
    measure()
  }, [content, measure])

  React.useLayoutEffect(() => {
    const element = trigger.current
    if (!element) return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [measure])

  React.useLayoutEffect(() => {
    const element = trigger.current
    if (!requested || !element) return
    const observer = new MutationObserver(measure)
    observer.observe(element, { childList: true, characterData: true, subtree: true })
    const fonts = element.ownerDocument.fonts
    fonts.addEventListener('loadingdone', measure)
    return () => {
      observer.disconnect()
      fonts.removeEventListener('loadingdone', measure)
    }
  }, [requested, measure])

  React.useLayoutEffect(() => {
    const element = trigger.current
    const interactive =
      'button, a[href], input, select, textarea, [role="button"], [role="tab"], [tabindex]:not([tabindex="-1"])'
    const parent = element?.parentElement?.closest<HTMLElement>(interactive)
    if (!element || element.matches(interactive) || !parent) return
    setFocusParent(true)
    const focus = () => {
      if (parent.matches(':focus-visible')) {
        measure()
        setRequested(true)
      }
    }
    const blur = () => setRequested(false)
    parent.addEventListener('focus', focus)
    parent.addEventListener('blur', blur)
    if (parent === element.ownerDocument.activeElement) focus()
    return () => {
      parent.removeEventListener('focus', focus)
      parent.removeEventListener('blur', blur)
    }
  }, [measure])

  return (
    <Tooltip
      open={requested && truncated && Boolean(content)}
      onOpenChange={(next) => {
        if (next) measure()
        setRequested(next)
      }}
      delayDuration={delayDuration}
      disableHoverableContent
    >
      <TooltipTrigger asChild ref={trigger} tabIndex={truncated && !focusParent ? 0 : undefined}>
        {children}
      </TooltipTrigger>
      {content && <TooltipContent {...placement}>{content}</TooltipContent>}
    </Tooltip>
  )
}

/** Shares the bubble and collision handling with DOM rendered outside React, such as editor tokens. */
export function AnchoredTooltip({
  target,
  content,
  onOpenChange,
  side = 'top',
  align,
  sideOffset,
}: TooltipPlacement & {
  target: Element | null
  content: React.ReactNode
  onOpenChange?: (open: boolean) => void
}) {
  const [bounds, setBounds] = React.useState<DOMRect | null>(null)
  const anchorRef = React.useRef<HTMLSpanElement>(null)
  const positioned = !!bounds
  React.useLayoutEffect(() => {
    if (!target) {
      setBounds(null)
      return
    }
    let frame = 0
    const measure = () => {
      if (
        !target.isConnected ||
        !target.getClientRects().length ||
        target.closest('[inert]') ||
        ['hidden', 'collapse'].includes(getComputedStyle(target).visibility)
      ) {
        setBounds(null)
        onOpenChange?.(false)
        return
      }
      const next = target.getBoundingClientRect()
      setBounds((previous) =>
        previous?.x === next.x &&
        previous.y === next.y &&
        previous.width === next.width &&
        previous.height === next.height
          ? previous
          : next,
      )
      frame = requestAnimationFrame(measure)
    }
    measure()
    return () => cancelAnimationFrame(frame)
  }, [target, onOpenChange])
  React.useEffect(() => {
    if (!target || !positioned) return
    const descriptionId = anchorRef.current?.getAttribute('aria-describedby')
    if (!descriptionId) return
    const descriptions = new Set((target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean))
    descriptions.add(descriptionId)
    target.setAttribute('aria-describedby', [...descriptions].join(' '))
    return () => {
      const remaining = (target.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter((id) => id && id !== descriptionId)
      if (remaining.length) target.setAttribute('aria-describedby', remaining.join(' '))
      else target.removeAttribute('aria-describedby')
    }
  }, [target, positioned])
  return (
    <Tooltip open={!!target && !!bounds} onOpenChange={onOpenChange} disableHoverableContent>
      <TooltipPrimitive.Portal forceMount>
        <TooltipTrigger asChild>
          <span
            ref={anchorRef}
            aria-hidden="true"
            style={{
              position: 'fixed',
              pointerEvents: 'none',
              left: bounds?.left ?? 0,
              top: bounds?.top ?? 0,
              width: bounds?.width ?? 0,
              height: bounds?.height ?? 0,
            }}
          />
        </TooltipTrigger>
      </TooltipPrimitive.Portal>
      <TooltipContent side={side} align={align} sideOffset={sideOffset} collisionPadding={12}>
        {content}
      </TooltipContent>
    </Tooltip>
  )
}

export function DelegatedTooltip({
  containerRef,
  delayDuration = 200,
}: {
  containerRef: React.RefObject<HTMLElement | null>
  delayDuration?: number
}) {
  const [hint, setHint] = React.useState<{ target: Element; content: string } | null>(null)
  const close = React.useCallback(() => setHint(null), [])
  const dismiss = React.useRef(close)
  const [container, setContainer] = React.useState<HTMLElement | null>(null)
  React.useLayoutEffect(() => {
    if (containerRef.current !== container) {
      setContainer(containerRef.current)
      close()
    }
  })
  React.useEffect(() => {
    if (!container) return
    const document = container.ownerDocument
    let timer: ReturnType<typeof setTimeout> | undefined
    let candidate: Element | null = null
    const find = (node: EventTarget | null) => {
      const target = node instanceof Element ? node.closest('[data-tooltip]') : null
      return target && container.contains(target) && target.getAttribute('data-tooltip') ? target : null
    }
    const hide = () => {
      clearTimeout(timer)
      candidate = null
      close()
    }
    dismiss.current = hide
    const show = (target: Element | null, immediately: boolean) => {
      if (candidate === target) return
      hide()
      candidate = target
      if (!target) return
      const reveal = () => {
        if (!target.isConnected || !container.contains(target)) return
        const content = target.getAttribute('data-tooltip')
        if (content) setHint({ target, content })
      }
      if (immediately) reveal()
      else timer = setTimeout(reveal, delayDuration)
    }
    const pointerOver = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' && event.buttons === 0) show(find(event.target), false)
    }
    const pointerOut = (event: PointerEvent) => {
      if (find(event.relatedTarget) !== candidate) hide()
    }
    const focusIn = (event: FocusEvent) => show(find(event.target), true)
    const focusOut = (event: FocusEvent) => {
      if (find(event.relatedTarget) !== candidate) hide()
    }
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    const observer = new MutationObserver(() => {
      if (!candidate) return
      if (!candidate.isConnected || !container.contains(candidate) || !find(candidate)) {
        hide()
        return
      }
      const target = candidate
      const content = target.getAttribute('data-tooltip')!
      setHint((previous) =>
        previous?.target === target && previous.content !== content ? { target, content } : previous,
      )
    })
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tooltip'] })
    container.addEventListener('pointerover', pointerOver)
    container.addEventListener('pointerout', pointerOut)
    container.addEventListener('focusin', focusIn)
    container.addEventListener('focusout', focusOut)
    container.addEventListener('input', hide)
    document.addEventListener('keydown', keyDown, true)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('scroll', hide, true)
    return () => {
      clearTimeout(timer)
      dismiss.current = close
      observer.disconnect()
      container.removeEventListener('pointerover', pointerOver)
      container.removeEventListener('pointerout', pointerOut)
      container.removeEventListener('focusin', focusIn)
      container.removeEventListener('focusout', focusOut)
      container.removeEventListener('input', hide)
      document.removeEventListener('keydown', keyDown, true)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('scroll', hide, true)
    }
  }, [container, delayDuration, close])
  const onOpenChange = React.useCallback((open: boolean) => {
    if (!open) dismiss.current()
  }, [])
  return <AnchoredTooltip target={hint?.target ?? null} content={hint?.content} onOpenChange={onOpenChange} />
}
