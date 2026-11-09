import { cn } from '@pi-meme/ui/lib/utils'

export function SidebarTitle({ children, className }: { children: string; className?: string }) {
  return <span className={cn('block min-w-0 truncate', className)}>{children}</span>
}
