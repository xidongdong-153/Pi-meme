import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, MoreHorizontal, Trash2, X } from 'lucide-react'
import type { MemoryEntry, MemorySource } from '@pi-meme/contracts/memory'
import { RevealContent } from '@pi-meme/ui/components/reveal-content'
import { Button } from '@pi-meme/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'

function linkedContent(content: string): ReactNode[] {
  const parts: ReactNode[] = []
  const links = /https?:\/\/[^\s<>"'`“”‘’，。！？；：、（）【】]+/giu
  let offset = 0
  for (const match of content.matchAll(links)) {
    let url = match[0].replace(/[.,;:!?]+$/, '')
    for (const [open, close] of [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ]) {
      while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1)
    }
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
    } catch {
      continue
    }
    parts.push(content.slice(offset, match.index))
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="rounded-sm underline decoration-muted-foreground/40 underline-offset-4 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {url}
      </a>,
    )
    offset = match.index + url.length
  }
  parts.push(content.slice(offset))
  return parts
}

export function MemoryEntryPreview({
  entry,
  scopeLabel,
  writable,
  connected,
  onEdit,
  onDelete,
  onClose,
  onShowSource,
}: {
  entry: MemoryEntry
  scopeLabel: string
  writable: boolean
  connected: boolean
  onEdit: () => void
  onDelete: () => void
  onClose: () => void
  onShowSource: (source: MemorySource) => void
}) {
  const sourcesId = useId()
  const headingId = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [expandedEntry, setExpandedEntry] = useState<string>()
  const sourcesExpanded = expandedEntry === entry.id
  const updatedAt = new Date(entry.updatedAt)
  const updatedLabel = Number.isNaN(updatedAt.getTime())
    ? entry.updatedAt
    : updatedAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
    setExpandedEntry(undefined)
  }, [entry.id])

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1 pt-1">
          <h3 id={headingId} className="text-sm font-medium leading-6 [overflow-wrap:anywhere]">
            {entry.title}
          </h3>
          <p className="text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
            {scopeLabel} · {entry.locked ? '手动保存，不自动覆盖' : '自动学习'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="sm" disabled={!writable} onClick={onEdit}>
            编辑
          </Button>
          <DropdownMenu>
            <TooltipHint content="更多操作">
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="更多记忆操作">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
            </TooltipHint>
            <DropdownMenuContent side="bottom" align="end">
              <DropdownMenuItem className="text-destructive" disabled={!writable} onSelect={onDelete}>
                <Trash2 />
                删除记忆
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <TooltipHint content="关闭预览">
            <Button
              variant="ghost"
              size="icon"
              aria-label="关闭记忆预览"
              className="hidden @[42rem]/memory:inline-flex"
              onClick={onClose}
            >
              <X />
            </Button>
          </TooltipHint>
        </div>
      </div>
      <div
        ref={scrollRef}
        role="region"
        aria-label="记忆内容"
        tabIndex={0}
        className="max-h-[min(32rem,60vh)] min-w-0 space-y-5 overflow-y-auto overscroll-contain rounded-sm pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="space-y-3">
          <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">
            {linkedContent(entry.content)}
          </p>
          <p className="text-xs leading-5 text-muted-foreground">更新于 {updatedLabel}</p>
        </div>
        {entry.sources.length > 0 && (
          <div className="border-t border-border/60 pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 gap-1.5 px-2 text-muted-foreground"
              aria-expanded={sourcesExpanded}
              aria-controls={sourcesId}
              onClick={() => setExpandedEntry(sourcesExpanded ? undefined : entry.id)}
            >
              <ChevronRight className={sourcesExpanded ? 'rotate-90' : undefined} />
              来源 · {entry.sources.length} 条
            </Button>
            <RevealContent id={sourcesId} ready={sourcesExpanded}>
              <div className="space-y-4 pb-1 pt-3">
                {entry.sources.map((source, index) => (
                  <div key={source.id} className="space-y-1.5 border-l border-border pl-3">
                    {source.excerpt && (
                      <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                        {source.excerpt}
                      </p>
                    )}
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs font-normal text-muted-foreground hover:text-foreground"
                      aria-label={`查看原文 ${index + 1}`}
                      disabled={!connected}
                      onClick={() => onShowSource(source)}
                    >
                      查看原文
                    </Button>
                  </div>
                ))}
              </div>
            </RevealContent>
          </div>
        )}
      </div>
    </section>
  )
}
