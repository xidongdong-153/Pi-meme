import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'
import { useId, useRef, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'

export const Collapsible = CollapsiblePrimitive.Root
export const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger
export const CollapsibleContent = CollapsiblePrimitive.CollapsibleContent

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement

export function CollapsibleSection({
  title,
  description,
  variant = 'panel',
  className,
  triggerClassName,
  contentClassName,
  actions,
  open: controlledOpen,
  onOpenChange,
  children,
}: {
  title: ReactNode
  description?: string
  variant?: 'panel' | 'inline'
  className?: string
  triggerClassName?: string
  contentClassName?: string
  actions?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const validationFrame = useRef<number | null>(null)
  const titleId = useId()
  const contentId = `${titleId}-content`
  function changeOpen(nextOpen: boolean) {
    if (!nextOpen && contentRef.current?.contains(document.activeElement))
      triggerRef.current?.focus({ preventScroll: true })
    if (controlledOpen === undefined) setLocalOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }
  const trigger = (
    <CollapsibleTrigger
      ref={triggerRef}
      type="button"
      id={titleId}
      aria-label={typeof title === 'string' ? title : undefined}
      aria-controls={contentId}
      className={cn(
        'ui-disclosure-trigger flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl text-left text-foreground transition-colors duration-200 hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset disabled:cursor-default disabled:opacity-50 motion-reduce:transition-none',
        variant === 'panel' ? 'px-4 py-3 text-sm' : 'px-2 py-2 text-xs',
        triggerClassName,
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block break-words font-medium [overflow-wrap:anywhere]">{title}</span>
        {description && <span className="mt-1 block truncate text-xs text-muted-foreground">{description}</span>}
      </span>
      <span className="ui-disclosure-icon flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary/50 text-muted-foreground transition-colors duration-200 group-data-[state=open]/disclosure:bg-primary/10 group-data-[state=open]/disclosure:text-primary motion-reduce:transition-none">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[state=open]/disclosure:rotate-90 motion-reduce:transition-none"
        />
      </span>
    </CollapsibleTrigger>
  )
  return (
    <Collapsible
      open={open}
      onOpenChange={changeOpen}
      onInvalidCapture={(event) => {
        if (open) return
        const showValidation = !event.defaultPrevented
        event.preventDefault()
        changeOpen(true)
        if (showValidation && validationFrame.current === null) {
          const control = event.target as FormControl
          // Reveal every enclosing section before native validation tries to focus a hidden field.
          validationFrame.current = requestAnimationFrame(() => {
            validationFrame.current = null
            if (!contentRef.current || contentRef.current.inert) return
            const firstInvalid = Array.from(control.form?.elements ?? [control]).find((element) => {
              const field = element as FormControl
              return field.willValidate && !field.validity.valid
            }) as FormControl | undefined
            if (!firstInvalid?.isConnected || firstInvalid.closest('[inert]')) return
            firstInvalid.focus()
            firstInvalid.reportValidity()
          })
        }
      }}
      className={cn(
        'ui-disclosure group/disclosure min-w-0 rounded-xl',
        variant === 'panel' && 'border border-border/70 bg-secondary/15',
        className,
      )}
    >
      {actions ? (
        <div className="ui-disclosure-heading flex min-w-0 items-center gap-1 pr-2">
          {trigger}
          {actions}
        </div>
      ) : (
        trigger
      )}
      <div
        ref={contentRef}
        id={contentId}
        data-state={open ? 'open' : 'closed'}
        role="region"
        aria-labelledby={titleId}
        aria-hidden={!open}
        inert={!open}
        className="ui-disclosure-content grid transition-[grid-template-rows,opacity] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] data-[state=closed]:grid-rows-[0fr] data-[state=closed]:opacity-0 data-[state=open]:grid-rows-[1fr] data-[state=open]:opacity-100 motion-reduce:transition-none"
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className={cn(
              'ui-disclosure-body flex min-w-0 flex-col gap-4',
              variant === 'panel' ? 'px-4 pb-4 pt-1' : 'px-2 pb-2 pt-1',
              contentClassName,
            )}
          >
            {children}
          </div>
        </div>
      </div>
    </Collapsible>
  )
}
