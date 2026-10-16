import type { CSSProperties, ReactNode } from 'react'
import { cn } from '../lib/utils'

export interface BentoSkeletonCardProps {
  children?: ReactNode
  className?: string
  style?: CSSProperties
  delay?: number
  testId?: string
}

export function BentoSkeletonCard({ children, className, style, delay, testId }: BentoSkeletonCardProps) {
  return (
    <div
      data-testid={testId}
      style={style}
      className={cn(
        'relative isolate overflow-hidden rounded-2xl border border-border/70 bg-card/60 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]',
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="bento-shimmer pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/[0.04] to-transparent dark:via-white/[0.08]"
        style={delay ? { animationDelay: `${delay}ms` } : undefined}
      />
      {children}
    </div>
  )
}

export interface BentoSkeletonBarProps {
  className?: string
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
}

export function BentoSkeletonBar({ className, size = 'md' }: BentoSkeletonBarProps) {
  const sizeClasses = {
    xs: 'h-2.5',
    sm: 'h-3.5',
    md: 'h-4',
    lg: 'h-6',
    xl: 'h-8',
  }
  return <div className={cn('animate-pulse rounded-md bg-muted/70', sizeClasses[size], className)} />
}

export interface BentoSkeletonCircleProps {
  className?: string
}

export function BentoSkeletonCircle({ className }: BentoSkeletonCircleProps) {
  return <div className={cn('size-10 shrink-0 animate-pulse rounded-full bg-muted/70', className)} />
}

export interface BentoSkeletonPillProps {
  className?: string
}

export function BentoSkeletonPill({ className }: BentoSkeletonPillProps) {
  return <div className={cn('h-7 animate-pulse rounded-full bg-muted/70', className)} />
}

export interface BentoSkeletonButtonProps {
  className?: string
}

export function BentoSkeletonButton({ className }: BentoSkeletonButtonProps) {
  return <div className={cn('h-8 w-20 shrink-0 animate-pulse rounded-lg bg-muted/70', className)} />
}
