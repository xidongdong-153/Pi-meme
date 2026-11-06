import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/utils'

export const settingsControlClassName = 'h-8 max-w-full rounded-lg text-xs shadow-none'
export const settingsCardClassName =
  'min-w-0 divide-y divide-border/40 overflow-hidden rounded-xl border border-border/70 bg-card/40 text-xs'

export function SettingsGroup({
  title,
  action,
  className,
  children,
  ...props
}: ComponentProps<'section'> & { title: string; action?: ReactNode }) {
  return (
    <section aria-label={title} className={cn('min-w-0 space-y-2', className)} {...props}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground select-none">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

export function SettingsCard({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn(settingsCardClassName, className)} {...props} />
}

export function SettingsRow({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs', className)}
      {...props}
    />
  )
}
