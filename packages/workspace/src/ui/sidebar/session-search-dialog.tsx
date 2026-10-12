import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Input } from '@pi-meme/ui/components/ui/input'
import { cn } from '@pi-meme/ui/lib/utils'
import { searchSidebarSessions, sidebarSessionTitle, type SidebarSessionEntry } from './sidebar-model'

export function SessionSearchDialog({
  open,
  onOpenChange,
  entries,
  serviceLabels,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entries: SidebarSessionEntry[]
  serviceLabels?: Record<string, string>
  onSelect: (entry: SidebarSessionEntry) => void
}) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const composing = useRef(false)
  const listId = useId()
  const results = useMemo(() => searchSidebarSessions(entries, query), [entries, query])
  const selectedIndex = Math.min(activeIndex, Math.max(0, results.length - 1))
  const activeKey = results[selectedIndex]?.key
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [open])
  useEffect(() => {
    if (open && activeKey) document.getElementById(`${listId}-${selectedIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, activeKey, listId, selectedIndex])
  const select = (entry: SidebarSessionEntry) => {
    onOpenChange(false)
    onSelect(entry)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-3 p-4"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          input.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (restoreFocus.current?.isConnected) restoreFocus.current.focus()
        }}
        onEscapeKeyDown={(event) => {
          if (composing.current) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>搜索聊天</DialogTitle>
          <DialogDescription className="sr-only">按聊天标题搜索，使用上下方向键选择，回车打开。</DialogDescription>
        </DialogHeader>
        <Input
          ref={input}
          role="combobox"
          aria-label="搜索聊天标题"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results.length ? `${listId}-${selectedIndex}` : undefined}
          placeholder="搜索聊天标题…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
          }}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            composing.current = false
          }}
          onKeyDown={(event) => {
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setActiveIndex(
                Math.min(
                  Math.max(0, selectedIndex + (event.key === 'ArrowDown' ? 1 : -1)),
                  Math.max(0, results.length - 1),
                ),
              )
            } else if (event.key === 'Enter' && results[selectedIndex]) {
              event.preventDefault()
              select(results[selectedIndex])
            }
          }}
        />
        <div
          id={listId}
          role="listbox"
          aria-label="聊天搜索结果"
          className="max-h-[min(60vh,32rem)] min-h-0 overflow-y-auto space-y-1"
        >
          {results.map((entry, index) => (
            <div
              key={entry.key}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={selectedIndex === index}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(entry)}
              className={cn(
                'flex min-w-0 items-center gap-3 cursor-pointer rounded-lg px-3 py-2 text-sm',
                selectedIndex === index ? 'bg-secondary' : 'hover:bg-secondary/60',
              )}
            >
              <div className="min-w-0 flex-1 truncate" title={sidebarSessionTitle(entry.session)}>
                {sidebarSessionTitle(entry.session)}
              </div>
              <div className="max-w-[45%] shrink-0 truncate text-right text-xs text-muted-foreground">
                {entry.projectName}
                {serviceLabels?.[entry.serviceId] ? ` · ${serviceLabels[entry.serviceId]}` : ''}
              </div>
            </div>
          ))}
          {!results.length && <p className="py-8 text-center text-sm text-muted-foreground">没有找到聊天</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
