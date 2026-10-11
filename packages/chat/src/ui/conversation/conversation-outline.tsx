import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'
import type { ConversationOutlineEntry } from '../model/types'
import * as React from 'react'

export function ConversationOutline({
  entries,
  activeKey,
  onSelect,
}: {
  entries: readonly ConversationOutlineEntry[]
  activeKey?: string
  onSelect: (entry: ConversationOutlineEntry) => void
}) {
  const listRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const list = listRef.current
    const active = list?.querySelector<HTMLElement>('[aria-current]')
    if (!list || !active) return
    const offset = active.getBoundingClientRect().top - list.getBoundingClientRect().top
    if (offset < 0) list.scrollTop += offset
    else if (offset + active.offsetHeight > list.clientHeight)
      list.scrollTop += offset + active.offsetHeight - list.clientHeight
  }, [activeKey])

  if (entries.length === 0) return null

  return (
    <nav aria-label="对话索引" className="absolute inset-y-6 left-1 z-20 flex w-8 flex-col justify-center sm:left-2">
      <div
        ref={listRef}
        className="overflow-y-auto overscroll-contain py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {entries.map((entry, index) => (
          <Tooltip key={entry.key} delayDuration={100}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`定位到第 ${index + 1} 条输入：${entry.title}`}
                aria-current={entry.key === activeKey ? 'location' : undefined}
                onClick={() => onSelect(entry)}
                className="group flex h-3 w-full cursor-pointer items-center rounded-sm px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'h-0.5 w-1.5 rounded-full transition-[width,background-color] duration-150 ease-out group-hover:w-6 group-hover:bg-foreground group-focus-visible:w-6 group-focus-visible:bg-foreground',
                    entry.key === activeKey ? 'bg-foreground' : 'bg-muted-foreground/35',
                  )}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              align="center"
              sideOffset={12}
              className="w-80 max-w-[min(calc(100vw-4rem),var(--radix-tooltip-content-available-width))] rounded-2xl border-border bg-secondary px-4 py-3 text-sm shadow-lg"
            >
              <p className="truncate font-medium text-foreground">{entry.title}</p>
              <p className="mt-1.5 line-clamp-3 leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                {entry.preview}
              </p>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </nav>
  )
}
