import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../../lib/utils'

export function FormField({
  label,
  description,
  className,
  children,
  ...props
}: ComponentProps<'label'> & { label: ReactNode; description?: ReactNode }) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-2 text-xs', className)} {...props}>
      <span className="font-medium leading-snug text-foreground [overflow-wrap:anywhere]">{label}</span>
      {children}
      {description && (
        <span className="text-[11px] font-normal leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {description}
        </span>
      )}
    </label>
  )
}
