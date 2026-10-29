import type { ReactNode } from 'react'
import { cn } from '../lib/utils'

export function FadeContent({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('ui-content-enter', className)}>{children}</div>
}
