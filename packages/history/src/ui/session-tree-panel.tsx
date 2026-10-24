import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, ChevronDown, ChevronRight, Copy, Terminal, User } from 'lucide-react'
import type { PiBranchEntry, PiSessionEntries } from '@pi-meme/contracts/pi'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { cn } from '@pi-meme/ui/lib/utils'
import { buildSessionTreeRows, type FilterMode, type SessionTreeRow } from './model/session-tree-rows'
import { HistoryMarkdown } from './history-markdown'

const FILTERS: Array<{ mode: FilterMode; label: string }> = [
  { mode: 'default', label: '默认' },
  { mode: 'all', label: '全部' },
  { mode: 'user', label: '仅用户' },
  { mode: 'no-tools', label: '无工具' },
]

function relativeTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const diff = Date.now() - date.getTime()
  if (diff < 45_000) return 'now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

function absoluteTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  return date.toLocaleString('zh-CN', { hour12: false })
}

function roleChip(entry: PiBranchEntry): { label: string; className: string } | null {
  if (entry.type !== 'message') return null
  if (entry.role === 'user') return { label: 'user', className: 'text-sky-400' }
  if (entry.role === 'assistant') return { label: 'pi', className: 'text-violet-400' }
  if (entry.role === 'system') return { label: 'system', className: 'text-muted-foreground' }
  return null
}

function cleanInlinePreview(entry: PiBranchEntry): string {
  const text = entry.preview?.trim()
  if (!text) {
    if (entry.type === 'message' && entry.role === 'assistant') return '(无正文)'
    return entry.type
  }
  return text
    .replace(/\r?\n/g, ' ')
    .replace(/^#+\s+/g, '')
    .replace(/\s+#+\s+/g, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function kindLabel(entry: PiBranchEntry): string {
  if (entry.type !== 'message') return entry.type
  if (entry.role === 'user') return '用户消息'
  if (entry.role === 'assistant') return '助手消息'
  if (entry.role === 'toolResult') return '工具结果'
  if (entry.role === 'system') return '系统消息'
  return entry.role ?? '消息'
}

function badgeTheme(entry: PiBranchEntry): string {
  if (entry.type !== 'message') {
    return 'border-border/60 bg-muted/40 text-muted-foreground'
  }
  switch (entry.role) {
    case 'assistant':
      return 'border-violet-500/30 bg-violet-500/10 text-violet-400'
    case 'user':
      return 'border-sky-500/30 bg-sky-500/10 text-sky-400'
    case 'toolResult':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-400'
    default:
      return 'border-border/60 bg-muted/40 text-muted-foreground'
  }
}

function RoleIcon({ entry, className }: { entry: PiBranchEntry; className?: string }) {
  const iconClass = cn('size-3 shrink-0', className)
  if (entry.type !== 'message') {
    return <Terminal className={iconClass} />
  }
  switch (entry.role) {
    case 'assistant':
      return <Bot className={iconClass} />
    case 'user':
      return <User className={iconClass} />
    case 'toolResult':
      return <Terminal className={iconClass} />
    default:
      return <Terminal className={iconClass} />
  }
}

function treePrefix(row: SessionTreeRow): string {
  if (row.indent === 0) return ''
  const connectorPosition = row.showConnector ? row.indent - 1 : -1
  let prefix = ''
  for (let level = 0; level < row.indent; level++) {
    const gutter = row.gutters.find((item) => item.position === level)
    if (gutter) prefix += gutter.show ? '│  ' : '   '
    else if (level === connectorPosition) prefix += row.isLast ? '└─ ' : '├─ '
    else prefix += '   '
  }
  return prefix
}

export function SessionTreePanel({ sessionEntries }: { sessionEntries: PiSessionEntries | undefined }) {
  const [searchQuery, setSearchQuery] = useState('')
  const [filterMode, setFilterMode] = useState<FilterMode>('default')
  const [foldedIds, setFoldedIds] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const model = useMemo(
    () => buildSessionTreeRows(sessionEntries, { filterMode, searchQuery, foldedIds }),
    [sessionEntries, filterMode, searchQuery, foldedIds],
  )

  // 首次加载或切换分支时，默认折叠非活动路径上的分支点。
  const lastLeaf = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const leaf = sessionEntries?.leafId ?? null
    if (lastLeaf.current === leaf) return
    lastLeaf.current = leaf
    const collapsed = new Set<string>()
    for (const [parentId, children] of model.childrenMap) {
      if (parentId !== null && children.length > 1 && !model.activeIds.has(parentId)) collapsed.add(parentId)
    }
    setFoldedIds(collapsed)
  }, [sessionEntries, model])

  const visibleIds = useMemo(() => new Set(model.rows.map((row) => row.entry.id)), [model])
  const resolvedSelectedId = useMemo(() => {
    if (selectedId && visibleIds.has(selectedId)) return selectedId
    let current = model.leafId ? model.byId.get(model.leafId) : undefined
    while (current) {
      if (visibleIds.has(current.id)) return current.id
      current = current.parentId ? model.byId.get(current.parentId) : undefined
    }
    return model.rows[0]?.entry.id ?? null
  }, [selectedId, visibleIds, model])
  const selectedEntry = resolvedSelectedId ? model.byId.get(resolvedSelectedId) : undefined

  useEffect(() => {
    setCopied(false)
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = null
    }
  }, [resolvedSelectedId])

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    }
  }, [])

  useEffect(() => {
    if (!resolvedSelectedId) return
    listRef.current
      ?.querySelector(`[data-entry-id="${CSS.escape(resolvedSelectedId)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [resolvedSelectedId])

  const toggleFold = (id: string) => {
    setFoldedIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCopy = (text: string) => {
    if (!text) return
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = setTimeout(setCopied, 2000, false)
    })
  }

  const selectedIndex = model.rows.findIndex((row) => row.entry.id === resolvedSelectedId)
  const filterLabel = FILTERS.find((item) => item.mode === filterMode)?.label ?? ''

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-border/60 px-3 py-2">
        <div className="text-[0.625rem] text-muted-foreground">
          {model.entryCount} 个节点{model.branchCount > 0 && ` · ${model.branchCount} 个分支点`}
        </div>
        {model.entryCount > 0 && (
          <>
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((item) => (
                <button
                  key={item.mode}
                  type="button"
                  onClick={() => setFilterMode(item.mode)}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[0.625rem] transition-colors',
                    filterMode === item.mode
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <Input
              placeholder="搜索正文、角色或工具..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="h-7 bg-transparent text-[0.6875rem]"
            />
          </>
        )}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto outline-none" aria-label="会话节点列表">
        {model.entryCount === 0 ? (
          <div className="px-3 py-5 text-center text-xs text-muted-foreground">当前会话没有分支记录</div>
        ) : model.rows.length === 0 ? (
          <div className="px-3 py-5 text-center text-xs text-muted-foreground">没有匹配的节点</div>
        ) : (
          model.rows.map((row) => {
            const chip = roleChip(row.entry)
            const active = model.activeIds.has(row.entry.id)
            const selected = row.entry.id === resolvedSelectedId
            const isLeaf = row.entry.id === model.leafId
            return (
              <div
                key={row.entry.id}
                data-entry-id={row.entry.id}
                onClick={() => setSelectedId(row.entry.id)}
                className={cn(
                  'group flex w-full cursor-pointer items-center gap-1.5 py-1.5 pr-2 text-left text-[0.6875rem] select-none transition-colors',
                  selected
                    ? 'bg-primary/15 font-medium text-foreground'
                    : 'text-foreground/85 hover:bg-secondary/60 hover:text-foreground',
                )}
                title={`${absoluteTime(row.entry.timestamp)} · ${row.entry.preview?.trim() || row.entry.type}`}
              >
                <span className="shrink-0 whitespace-pre font-mono text-[0.6875rem] leading-none text-border">
                  {treePrefix(row)}
                </span>
                {row.foldable ? (
                  <span
                    aria-label={row.folded ? '展开分支' : '折叠分支'}
                    className="flex size-3.5 shrink-0 items-center justify-center rounded-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={(event) => {
                      event.stopPropagation()
                      toggleFold(row.entry.id)
                    }}
                  >
                    {row.folded ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                  </span>
                ) : (
                  <span className="size-3.5 shrink-0" />
                )}
                <span className="w-14 shrink-0 text-right text-[0.625rem] tabular-nums text-muted-foreground">
                  {relativeTime(row.entry.timestamp)}
                </span>
                <span className="w-2 shrink-0 text-center text-[0.6875rem] text-primary" aria-hidden>
                  {active ? '•' : ''}
                </span>
                <span className={cn('min-w-0 flex-1 truncate', isLeaf ? 'text-foreground' : 'text-foreground/80')}>
                  {chip && <span className={cn('font-semibold', chip.className)}>{chip.label}: </span>}
                  <span>{cleanInlinePreview(row.entry)}</span>
                </span>
                {row.childCount > 1 && (
                  <span className="shrink-0 rounded bg-secondary/80 px-1 text-[0.625rem] text-muted-foreground">
                    {row.childCount}
                  </span>
                )}
              </div>
            )
          })
        )}
      </div>

      {selectedEntry && (
        <div className="flex max-h-[55%] min-h-[160px] shrink-0 flex-col border-t border-border/70 bg-card/60">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 bg-muted/20 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[0.6875rem] font-medium leading-none border',
                  badgeTheme(selectedEntry),
                )}
              >
                <RoleIcon entry={selectedEntry} />
                {kindLabel(selectedEntry)}
              </span>
              <span
                className="truncate text-[0.6875rem] text-muted-foreground tabular-nums"
                title={absoluteTime(selectedEntry.timestamp)}
              >
                {absoluteTime(selectedEntry.timestamp)}
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {selectedEntry.preview?.trim() && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="size-6 text-muted-foreground hover:text-foreground"
                  title={copied ? '已复制' : '复制正文'}
                  onClick={() => handleCopy(selectedEntry.preview?.trim() ?? '')}
                >
                  {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                </Button>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[0.6875rem]">
            {selectedEntry.preview?.trim() ? (
              selectedEntry.role === 'toolResult' && selectedEntry.preview.startsWith('[') ? (
                <div className="rounded border border-border/60 bg-muted/40 p-2 font-mono text-[0.6875rem] leading-relaxed text-foreground select-text whitespace-pre-wrap break-all">
                  {selectedEntry.preview.trim()}
                </div>
              ) : (
                <div className="session-tree-content text-[0.6875rem] leading-relaxed text-foreground break-words select-text [&_.pi-markdown]:!text-[0.6875rem] [&_.pi-markdown]:!leading-relaxed [&_.pi-h1]:!text-xs [&_.pi-h1]:!font-semibold [&_.pi-h1]:!my-1.5 [&_.pi-h1]:!pb-0.5 [&_.pi-h2]:!text-[0.6875rem] [&_.pi-h2]:!font-semibold [&_.pi-h2]:!my-1 [&_.pi-h2]:!pb-0.5 [&_.pi-h3]:!text-[0.6875rem] [&_.pi-h3]:!font-medium [&_.pi-h3]:!my-0.5 [&_.pi-p]:!mb-1.5 [&_.pi-p]:!leading-relaxed [&_.pi-ul]:!mb-1.5 [&_.pi-ul]:!pl-3.5 [&_.pi-ol]:!mb-1.5 [&_.pi-li]:!mb-0.5 [&_.pi-li]:!leading-relaxed [&_.pi-code-block]:!my-1.5 [&_.pi-code-block]:!text-[0.625rem] [&_.pi-inline-code]:!text-[0.625rem]">
                  <HistoryMarkdown>{selectedEntry.preview.trim()}</HistoryMarkdown>
                </div>
              )
            ) : (
              <div className="flex h-16 items-center justify-center text-[0.6875rem] text-muted-foreground/60 italic">
                {selectedEntry.type === 'message' && selectedEntry.role === 'assistant'
                  ? '（助手无输出正文）'
                  : '（无正文内容）'}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex shrink-0 items-center justify-between border-t border-border/70 px-3 py-1.5 text-[0.625rem] text-muted-foreground">
        <span>
          已选 {selectedIndex >= 0 ? selectedIndex + 1 : 0} / 共 {model.rows.length} 节点
        </span>
        <span className="tabular-nums">过滤: {filterLabel}</span>
      </div>
    </div>
  )
}
