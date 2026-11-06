import { useEffect, useState } from 'react'
import { cn } from '../lib/utils'

export function CrossfadeText({
  children,
  reserve,
  className,
  textClassName,
}: {
  children: string
  reserve?: readonly string[]
  className?: string
  textClassName?: string
}) {
  const [frame, setFrame] = useState({ text: children, previous: null as string | null, revision: 0 })
  if (frame.text !== children) {
    setFrame({ text: children, previous: frame.text, revision: frame.revision + 1 })
  }

  useEffect(() => {
    if (frame.previous === null) return
    const timer = window.setTimeout(() => {
      setFrame((current) => ({ ...current, previous: null }))
    }, 180)
    return () => window.clearTimeout(timer)
  }, [frame.revision, frame.previous])

  return (
    <span className={cn('relative inline-grid min-w-0 align-bottom', className)}>
      {reserve?.map((text) => (
        <span
          key={text}
          aria-hidden="true"
          className={cn('invisible col-start-1 row-start-1 select-none', textClassName)}
        >
          {text}
        </span>
      ))}
      <span
        key={frame.revision}
        className={cn('col-start-1 row-start-1 min-w-0', frame.previous !== null && 'ui-text-enter', textClassName)}
      >
        {children}
      </span>
      {frame.previous !== null && (
        // 旧文字也参与网格尺寸计算，避免新文案变短时把退场文字挤换行。
        <span
          key={`previous-${frame.revision}`}
          aria-hidden="true"
          className={cn('ui-text-exit pointer-events-none col-start-1 row-start-1 min-w-0 select-none', textClassName)}
        >
          {frame.previous}
        </span>
      )}
    </span>
  )
}
