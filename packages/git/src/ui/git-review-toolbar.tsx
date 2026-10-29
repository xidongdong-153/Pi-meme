import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  Columns2,
  ChevronsUpDown,
  GitBranch,
  GitCommitHorizontal,
  MoreHorizontal,
  RefreshCw,
  Search,
  WrapText,
} from 'lucide-react'
import type { GitReviewOptions } from '@pi-meme/contracts/git-review'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { cn } from '@pi-meme/ui/lib/utils'
import { scopeLabels, type ReviewScope, type ReadingPreferences } from './git-review-preferences'

export function ReviewTool({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'size-7 rounded-full text-muted-foreground [&_svg]:size-3.5',
        active && 'bg-background text-foreground shadow-xs',
      )}
    >
      {children}
    </Button>
  )
}

export function GitReviewToolbar({
  scope,
  onScope,
  insertions,
  deletions,
  loading,
  onRefresh,
  allExpanded,
  onExpand,
  reading,
  onReading,
  children,
}: {
  scope: ReviewScope
  onScope: (scope: ReviewScope) => void
  insertions: number
  deletions: number
  loading: boolean
  onRefresh: () => void
  allExpanded: boolean
  onExpand: () => void
  reading: ReadingPreferences
  onReading: (reading: ReadingPreferences) => void
  children?: ReactNode
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2.5">
      <div className="flex h-8 items-center gap-2 rounded-full bg-secondary/70 pr-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`变更范围：${scopeLabels[scope]}`}
              className="flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
            >
              {scopeLabels[scope]}
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuRadioGroup value={scope} onValueChange={(value) => onScope(value as ReviewScope)}>
              <div className="px-2.5 py-1.5 text-[10px] text-muted-foreground">Agent 修改</div>
              {(['turn', 'previous-turn'] as const).map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {scopeLabels[value]}
                </DropdownMenuRadioItem>
              ))}
              <DropdownMenuSeparator />
              <div className="px-2.5 py-1.5 text-[10px] text-muted-foreground">Git 变更</div>
              {(['uncommitted', 'unstaged', 'staged', 'commit', 'branch'] as const).map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {scopeLabels[value]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="font-mono text-xs tabular-nums text-emerald-600 dark:text-emerald-400">+{insertions}</span>
        <span className="font-mono text-xs tabular-nums text-rose-600 dark:text-rose-400">−{deletions}</span>
      </div>
      {children}
      <div className="ml-auto flex items-center gap-0.5 rounded-full bg-secondary/60 p-0.5">
        <ReviewTool label="刷新变更" disabled={loading} onClick={onRefresh}>
          <RefreshCw className={loading ? 'animate-spin' : ''} />
        </ReviewTool>
        <ReviewTool label={allExpanded ? '收起全部差异' : '展开全部差异'} onClick={onExpand}>
          <ChevronsUpDown />
        </ReviewTool>
        <ReviewTool
          label="自动换行"
          active={reading.wrap}
          onClick={() => onReading({ ...reading, wrap: !reading.wrap })}
        >
          <WrapText />
        </ReviewTool>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 rounded-full"
              title="差异布局"
              aria-label="差异布局"
            >
              <Columns2 className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom">
            <DropdownMenuRadioGroup
              value={reading.layout}
              onValueChange={(layout) => onReading({ ...reading, layout: layout as ReadingPreferences['layout'] })}
            >
              <DropdownMenuRadioItem value="auto">自动布局</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="unified">单栏</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="split">双栏</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 rounded-full"
              title="更多阅读操作"
              aria-label="更多阅读操作"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom">
            <DropdownMenuItem onSelect={onExpand}>{allExpanded ? '收起全部差异' : '展开全部差异'}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onReading({ layout: 'auto', wrap: true })}>
              恢复默认阅读设置
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

export function ReviewTargetPicker({
  kind,
  value,
  branch,
  load,
  onSelect,
}: {
  kind: 'branch' | 'commit'
  value?: string
  branch?: string
  load: (input: { search?: string; offset?: number }) => Promise<GitReviewOptions>
  onSelect: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [options, setOptions] = useState<GitReviewOptions>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(0)
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (!open) return
    const id = ++request.current
    setBusy(true)
    const timer = setTimeout(() => {
      void loadRef
        .current({ search: kind === 'commit' ? search : undefined })
        .then((result) => {
          if (id === request.current) {
            setOptions(result)
            setError('')
          }
        })
        .catch((cause) => {
          if (id === request.current) setError(String(cause))
        })
        .finally(() => {
          if (id === request.current) setBusy(false)
        })
    }, 180)
    return () => {
      clearTimeout(timer)
      request.current++
    }
  }, [open, search, kind])
  async function more() {
    const id = request.current
    setBusy(true)
    try {
      const result = await loadRef.current({ search, offset: options?.commits.length ?? 0 })
      if (id === request.current)
        setOptions((current) => ({ ...result, commits: [...(current?.commits ?? []), ...result.commits] }))
    } catch (cause) {
      if (id === request.current) setError(String(cause))
    } finally {
      if (id === request.current) setBusy(false)
    }
  }
  const label = kind === 'branch' ? value?.replace(/^refs\/(heads|remotes)\//, '') : value?.slice(0, 7)
  const items =
    kind === 'branch'
      ? options?.branches
          .filter((item) => item.name.toLowerCase().includes(search.toLowerCase()))
          .map((item) => ({ id: item.ref, title: item.name, detail: item.kind === 'remote' ? '远程' : '本地' }))
      : options?.commits.map((item) => ({ id: item.sha, title: item.subject, detail: item.sha.slice(0, 7) }))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-8 min-w-0 max-w-full items-center gap-2 rounded-full bg-secondary/70 px-3 text-xs hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={kind === 'branch' ? '选择比较分支' : '选择提交'}
          title={value}
        >
          {kind === 'branch' ? (
            <GitBranch className="size-3.5 shrink-0" />
          ) : (
            <GitCommitHorizontal className="size-3.5 shrink-0" />
          )}
          <span className="truncate">
            {kind === 'branch' && branch ? `${branch} → ` : ''}
            {label || (kind === 'branch' ? '选择比较分支' : '选择提交')}
          </span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-80 max-w-[calc(100vw-2rem)] rounded-xl p-2">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 size-3.5 text-muted-foreground" />
          <Input
            aria-label={kind === 'branch' ? '搜索分支' : '搜索提交'}
            placeholder={kind === 'branch' ? '搜索分支' : '搜索提交摘要'}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-8 pl-7 text-xs"
          />
        </div>
        <div className="mt-2 max-h-72 overflow-y-auto" aria-busy={busy}>
          {items?.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => {
                onSelect(item.id)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="min-w-0 flex-1 truncate" title={item.title}>
                {item.title}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{item.detail}</span>
              {value === item.id && <Check className="size-3.5 shrink-0" />}
            </button>
          ))}
          {options?.error && (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              {options.error === 'not-repository'
                ? '当前项目未使用 Git，可切换到 Agent 修改。'
                : '当前环境未安装 Git，可切换到 Agent 修改。'}
            </p>
          )}
          {!busy && !items?.length && !error && !options?.error && (
            <p className="px-2 py-4 text-xs text-muted-foreground">没有匹配的{kind === 'branch' ? '分支' : '提交'}</p>
          )}
          {busy && (
            <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
              正在读取…
            </p>
          )}
          {error && (
            <p role="alert" className="px-2 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          {kind === 'commit' && options?.hasMore && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void more()} className="w-full">
              加载更多提交
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
