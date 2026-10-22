import { keybindingDisplayParts, type ShortcutPlatform } from '@pi-meme/contracts/keyboard-shortcuts'
import { cn } from '@pi-meme/ui/lib/utils'

export function ShortcutKeycap({
  binding,
  platform,
  className,
}: {
  binding: string | null | undefined
  platform: ShortcutPlatform
  className?: string
}) {
  if (!binding) {
    return <span className={cn('text-xs text-muted-foreground/60 italic', className)}>未绑定</span>
  }
  const parts = keybindingDisplayParts(binding, platform)
  return (
    <span className={cn('inline-flex items-center gap-1 font-mono text-[11px]', className)}>
      {parts.map((part, index) => (
        <kbd
          key={`${part}-${index}`}
          className="inline-flex min-w-[20px] h-5 items-center justify-center rounded border border-border/80 bg-muted/60 px-1.5 text-foreground shadow-2xs select-none"
        >
          {part}
        </kbd>
      ))}
    </span>
  )
}
