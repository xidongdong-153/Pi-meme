import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'
import { useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'

export const Collapsible = CollapsiblePrimitive.Root
export const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger
export const CollapsibleContent = CollapsiblePrimitive.CollapsibleContent

export function CollapsibleSection({
  title,
  description,
  variant = 'panel',
  className,
  children,
}: {
  title: string
  description?: string
  variant?: 'panel' | 'inline'
  className?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const titleId = useId()
  const contentId = `${titleId}-content`
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        'group/disclosure min-w-0 rounded-xl',
        variant === 'panel' && 'border border-border/70 bg-secondary/15',
        className,
      )}
    >
      <CollapsibleTrigger
        id={titleId}
        aria-label={title}
        aria-controls={contentId}
        className={cn(
          'flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl text-left text-foreground transition-colors duration-200 hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset disabled:cursor-default disabled:opacity-50',
          variant === 'panel' ? 'px-4 py-3 text-sm' : 'px-2 py-2 text-xs',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{title}</span>
          {description && <span className="mt-1 block truncate text-xs text-muted-foreground">{description}</span>}
        </span>
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary/50 text-muted-foreground transition-colors duration-200 group-data-[state=open]/disclosure:bg-primary/10 group-data-[state=open]/disclosure:text-primary">
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[state=open]/disclosure:rotate-90"
          />
        </span>
      </CollapsibleTrigger>
      <div
        id={contentId}
        data-state={open ? 'open' : 'closed'}
        role="region"
        aria-labelledby={titleId}
        aria-hidden={!open}
        inert={!open}
        className="grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] data-[state=closed]:grid-rows-[0fr] data-[state=closed]:opacity-0 data-[state=open]:grid-rows-[1fr] data-[state=open]:opacity-100"
      >
        <div className="min-h-0 overflow-hidden">
          <div className={variant === 'panel' ? 'px-4 pb-4 pt-1' : 'px-2 pb-2 pt-1'}>{children}</div>
        </div>
      </div>
    </Collapsible>
  )
}
