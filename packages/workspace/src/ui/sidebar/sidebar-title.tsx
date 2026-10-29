import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { cn } from '@pi-meme/ui/lib/utils'
import './sidebar-title.css'

export function SidebarTitle({ children, className }: { children: string; className?: string }) {
  const viewport = useRef<HTMLSpanElement>(null)
  const content = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(0)

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

  return (
    <span
      ref={viewport}
      className={cn('sidebar-title min-w-0', className)}
      data-overflow={overflow > 1}
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
}
