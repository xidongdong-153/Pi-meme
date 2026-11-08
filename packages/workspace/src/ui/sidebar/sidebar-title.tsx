import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { cn } from '@pi-meme/ui/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import './sidebar-title.css'

export function SidebarTitle({
  children,
  className,
  revealFullText = false,
}: {
  children: string
  className?: string
  revealFullText?: boolean
}) {
  const viewport = useRef<HTMLSpanElement>(null)
  const content = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(0)
  const [requested, setRequested] = useState(false)
  const [focusParent, setFocusParent] = useState(false)

  useLayoutEffect(() => {
    const element = viewport.current!
    const label = content.current!
    const measure = () => setOverflow(Math.max(0, label.scrollWidth - element.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    observer.observe(label)
    return () => observer.disconnect()
  }, [children])

  useLayoutEffect(() => {
    if (!revealFullText) return
    const element = viewport.current!
    const parent = element.parentElement?.closest<HTMLElement>('button, a[href], [role="tab"], [role="button"]')
    if (!parent) return
    setFocusParent(true)
    const focus = () => {
      if (parent.matches(':focus-visible')) setRequested(true)
    }
    const blur = () => setRequested(false)
    parent.addEventListener('focus', focus)
    parent.addEventListener('blur', blur)
    if (parent === element.ownerDocument.activeElement) focus()
    return () => {
      parent.removeEventListener('focus', focus)
      parent.removeEventListener('blur', blur)
    }
  }, [revealFullText])

  const label = (
    <span
      ref={viewport}
      className={cn('sidebar-title min-w-0', className)}
      data-overflow={overflow > 1}
      tabIndex={revealFullText && overflow > 1 && !focusParent ? 0 : undefined}
      style={
        {
          '--sidebar-title-offset': `${-overflow}px`,
          '--sidebar-title-duration': `${Math.max(1200, (overflow / 28) * 1000)}ms`,
          '--sidebar-title-fade': `${Math.min(16, overflow)}px`,
        } as CSSProperties
      }
    >
      <span ref={content}>{children}</span>
    </span>
  )
  if (!revealFullText) return label
  return (
    <Tooltip open={requested && overflow > 1} onOpenChange={setRequested} disableHoverableContent>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  )
}
