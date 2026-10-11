import { Sparkles } from 'lucide-react'
import type { ActivityItem } from '../model/types'
import { cn } from '@pi-meme/ui/lib/utils'

export function NarrationActivityRow({
  item,
  isPaused = false,
  isNested = false,
}: {
  item: Extract<ActivityItem, { type: 'narration' }>
  isPaused?: boolean
  isNested?: boolean
}) {
  return (
    <div className={cn('flex items-start gap-1.5 py-1 px-1.5 -mx-1 text-xs text-muted-foreground', isNested && 'pl-2')}>
      {!isPaused && <Sparkles className="size-3.5 shrink-0 mt-0.5 text-muted-foreground/70" />}
      <span className="font-mono text-[0.75rem] italic text-muted-foreground/90">{item.text}</span>
    </div>
  )
}
