import { useRef } from 'react'
import type { ComponentType, ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { cn } from './utils'

interface MenuItem {
  label: string
  icon: ComponentType<{ size?: number; strokeWidth?: number }>
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
}
export function Menu({
  label,
  children,
  items,
  side = 'bottom',
  className,
}: {
  label: string
  children: ReactNode
  items: MenuItem[]
  side?: 'top' | 'bottom'
  className?: string
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const selectedAction = useRef<(() => void) | undefined>(undefined)
  return (
    <div className={cn('popup-menu', `popup-menu-${side}`, className)}>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button ref={trigger} type="button" className="menu-trigger" aria-label={label}>
            {children}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="bot-dropdown-content"
          aria-label={label}
          side={side}
          align={side === 'top' ? 'start' : 'end'}
          sideOffset={8}
          collisionPadding={12}
          onEscapeKeyDown={(event) => {
            if (event.isComposing || event.keyCode === 229) event.preventDefault()
          }}
          onKeyDownCapture={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) event.stopPropagation()
          }}
          onCloseAutoFocus={(event) => {
            const action = selectedAction.current
            if (!action) return
            selectedAction.current = undefined
            event.preventDefault()
            // Run navigation after the menu returns focus so a newly opened dialog keeps its own focus.
            trigger.current?.focus({ preventScroll: true })
            action()
          }}
        >
          {items.map((item) => (
            <DropdownMenuItem
              key={item.label}
              disabled={item.disabled}
              className={cn('bot-dropdown-item', item.danger && 'danger')}
              onSelect={() => {
                selectedAction.current = item.onSelect
              }}
            >
              <item.icon size={16} strokeWidth={1.7} />
              <span>{item.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
