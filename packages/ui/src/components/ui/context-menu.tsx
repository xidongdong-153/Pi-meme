import * as Primitive from '@radix-ui/react-context-menu'
import type { ComponentProps } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'

export const ContextMenu = Primitive.Root
export const ContextMenuTrigger = Primitive.Trigger
export const ContextMenuSub = Primitive.Sub

const contentClass =
  'z-50 min-w-48 max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl'
const itemClass =
  'flex items-center gap-2 rounded-md px-2.5 py-2 text-xs outline-none cursor-pointer data-[highlighted]:bg-secondary data-[disabled]:opacity-40 data-[disabled]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0'

export function ContextMenuContent({ className, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content className={cn(contentClass, className)} {...props} />
    </Primitive.Portal>
  )
}
export function ContextMenuItem({ className, ...props }: ComponentProps<typeof Primitive.Item>) {
  return <Primitive.Item className={cn(itemClass, className)} {...props} />
}
export function ContextMenuSeparator() {
  return <Primitive.Separator className="my-1 h-px bg-border" />
}
export function ContextMenuSubTrigger({ children, className, ...props }: ComponentProps<typeof Primitive.SubTrigger>) {
  return (
    <Primitive.SubTrigger className={cn(itemClass, className)} {...props}>
      {children}
      <ChevronRight className="ml-auto" />
    </Primitive.SubTrigger>
  )
}
export function ContextMenuSubContent({ className, ...props }: ComponentProps<typeof Primitive.SubContent>) {
  return (
    <Primitive.Portal>
      <Primitive.SubContent className={cn(contentClass, className)} {...props} />
    </Primitive.Portal>
  )
}
