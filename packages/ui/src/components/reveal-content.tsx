import type { ReactNode } from 'react'
import { cn } from '../lib/utils'

/** 保留容器，用于异步区域就绪时展开；固定标题和操作放在容器外。 */
export function RevealContent({
  ready,
  children,
  className,
}: {
  ready: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] data-[ready=true]:grid-rows-[1fr] data-[ready=true]:opacity-100 motion-reduce:transition-none',
        className,
      )}
      data-ready={ready}
      inert={!ready}
      aria-hidden={!ready}
    >
      <div className={cn('min-h-0', ready ? 'ui-reveal-clip' : 'overflow-hidden')}>{children}</div>
    </div>
  )
}
