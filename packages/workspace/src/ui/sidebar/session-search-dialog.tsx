import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import { cn } from '@pi-meme/ui/lib/utils'
import { skillMessageText } from '@pi-meme/contracts/skills'
import { searchSidebarSessions, sidebarSessionTitle, type SidebarSessionEntry } from './sidebar-model'
import { searchSidebarContents, type SidebarContentSearch, type SessionSearchReader } from './session-search'

const emptyContent: SidebarContentSearch = { matches: [], errors: [] }
function projectKey(entry: SidebarSessionEntry) {
  return JSON.stringify([
    entry.serviceId,
    entry.session.workspaceKind === 'standalone' ? '' : (entry.session.sourceProjectCwd ?? entry.session.cwd),
  ])
}

export function SessionSearchDialog({
  open,
  onOpenChange,
  entries,
  serviceLabels,
  searchHistory,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entries: SidebarSessionEntry[]
  serviceLabels?: Record<string, string>
  searchHistory?: SessionSearchReader
  onSelect: (entry: SidebarSessionEntry) => void
}) {
  const [query, setQuery] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [project, setProject] = useState('')
  const [limit, setLimit] = useState(100)
  const [activeIndex, setActiveIndex] = useState(0)
  const [content, setContent] = useState({ ...emptyContent, scope: '', loading: false })
  const input = useRef<HTMLInputElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const composing = useRef(false)
  const listId = useId()
  const services = useMemo(() => [...new Set(entries.map((entry) => entry.serviceId))], [entries])
  const projects = useMemo(
    () =>
      new Map(
        entries
          .filter((entry) => !serviceId || entry.serviceId === serviceId)
          .map((entry) => [projectKey(entry), entry]),
      ),
    [entries, serviceId],
  )
  const scoped = useMemo(
    () =>
      entries.filter(
        (entry) => (!serviceId || entry.serviceId === serviceId) && (!project || projectKey(entry) === project),
      ),
    [entries, serviceId, project],
  )
  const scope = JSON.stringify([query.trim(), serviceId, project])
  const matches = useMemo(
    () => new Map(content.scope === scope ? content.matches.map((match) => [match.key, match.excerpt]) : []),
    [content, scope],
  )
  const allResults = useMemo(() => {
    const titles = searchSidebarSessions(scoped, query)
    if (!query.trim()) return titles
    const keys = new Set(titles.map((entry) => entry.key))
    return scoped.filter((entry) => keys.has(entry.key) || matches.has(entry.key))
  }, [scoped, query, matches])
  const results = allResults.slice(0, limit)
  const searching = Boolean(open && query.trim() && searchHistory && (content.scope !== scope || content.loading))
  const errors = content.scope === scope ? content.errors : []
  const selectedIndex = Math.min(activeIndex, Math.max(0, results.length - 1))
  const activeKey = results[selectedIndex]?.key
  useEffect(() => {
    if (open) {
      setQuery('')
      setServiceId('')
      setProject('')
      setActiveIndex(0)
      setLimit(100)
    }
  }, [open])
  useEffect(() => {
    if (!open || !query.trim() || !searchHistory) return
    let current = true
    setContent((previous) => ({
      ...(previous.scope === scope ? previous : emptyContent),
      scope,
      loading: true,
    }))
    const timer = setTimeout(() => {
      void searchSidebarContents(query.trim(), scoped, searchHistory).then((value) => {
        if (current) setContent({ ...value, scope, loading: false })
      })
    }, 250)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [open, query, scoped, scope, searchHistory])
  useEffect(() => {
    if (open && activeKey) document.getElementById(`${listId}-${selectedIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, activeKey, listId, selectedIndex])
  const resetSelection = () => {
    setActiveIndex(0)
    setLimit(100)
  }
  const select = (entry: SidebarSessionEntry) => {
    onOpenChange(false)
    onSelect(entry)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-3 p-4 sm:max-w-2xl"
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
          <DialogDescription className="sr-only">
            搜索标题和聊天正文，可按服务或项目筛选。上下方向键选择，回车打开。
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          {(services.length > 1 || serviceId) && (
            <Select
              value={serviceId || 'all'}
              onValueChange={(value) => {
                setServiceId(value === 'all' ? '' : value)
                setProject('')
                resetSelection()
              }}
            >
              <SelectTrigger aria-label="筛选服务" className="min-w-0 flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部服务</SelectItem>
                {services.map((id) => (
                  <SelectItem key={id} value={id}>
                    {serviceLabels?.[id] ?? '本机服务'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select
            value={project || 'all'}
            onValueChange={(value) => {
              setProject(value === 'all' ? '' : value)
              resetSelection()
            }}
          >
            <SelectTrigger aria-label="筛选项目" className="min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部项目</SelectItem>
              {[...projects].map(([key, entry]) => (
                <SelectItem key={key} value={key}>
                  {entry.projectName}
                  {serviceLabels?.[entry.serviceId] ? ` · ${serviceLabels[entry.serviceId]}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Input
          ref={input}
          role="combobox"
          aria-label="搜索聊天标题"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results.length ? `${listId}-${selectedIndex}` : undefined}
          placeholder="搜索标题或聊天正文…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            resetSelection()
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
        {searching && (
          <p role="status" className="text-xs text-muted-foreground">
            正在搜索历史正文…
          </p>
        )}
        {errors.map((error) => (
          <p key={error.serviceId} role="alert" className="break-words text-xs text-destructive">
            {serviceLabels?.[error.serviceId] ?? '当前服务'}的正文搜索失败：{error.message}
          </p>
        ))}
        <div
          id={listId}
          role="listbox"
          aria-label="聊天搜索结果"
          aria-busy={searching}
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
                'cursor-pointer rounded-lg px-3 py-2 text-sm',
                selectedIndex === index ? 'bg-secondary' : 'hover:bg-secondary/60',
              )}
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="min-w-0 flex-1 truncate" title={sidebarSessionTitle(entry.session)}>
                  {sidebarSessionTitle(entry.session)}
                </div>
                <div className="max-w-[45%] shrink-0 truncate text-right text-xs text-muted-foreground">
                  {entry.projectName}
                  {serviceLabels?.[entry.serviceId] ? ` · ${serviceLabels[entry.serviceId]}` : ''}
                </div>
              </div>
              {(matches.get(entry.key) || entry.session.firstMessage) && (
                <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
                  {matches.get(entry.key) ??
                    skillMessageText(entry.session.firstMessage ?? '')
                      .replace(/\s+/g, ' ')
                      .slice(0, 160)}
                </p>
              )}
            </div>
          ))}
          {!results.length && !searching && (
            <p className="py-8 text-center text-sm text-muted-foreground">没有找到聊天</p>
          )}
        </div>
        {allResults.length > limit && (
          <Button variant="outline" size="sm" onClick={() => setLimit((value) => value + 100)}>
            加载更多结果（剩余 {allResults.length - limit} 条）
          </Button>
        )}
      </DialogContent>
    </Dialog>
  )
}
