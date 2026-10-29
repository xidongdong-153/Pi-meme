import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Copy, ExternalLink, MoreHorizontal, RefreshCw } from 'lucide-react'
import type {
  GitReviewFile,
  GitReviewFileContent,
  GitReviewOptions,
  GitReviewQuery,
  GitReviewSnapshot,
} from '@pi-meme/contracts/git-review'
import type { TurnChanges } from '@pi-meme/contracts/turn-changes'
import { FileIcon } from '@pi-meme/ui/components/file-icon'
import { Button } from '@pi-meme/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { cn } from '@pi-meme/ui/lib/utils'
import { GitDiffViewer } from './git-diff-viewer'
import { GitReviewToolbar, ReviewTargetPicker } from './git-review-toolbar'
import {
  projectReviewKey,
  readProjectReview,
  readReadingPreferences,
  saveReadingPreferences,
  saveReviewPreferences,
  type ProjectReviewPreferences,
} from './git-review-preferences'

export type GitReviewBridge = {
  review: (query: GitReviewQuery) => Promise<GitReviewSnapshot>
  file: (input: { query: GitReviewQuery; path: string }) => Promise<GitReviewFileContent>
  options: (input: { search?: string; offset?: number }) => Promise<GitReviewOptions>
  turnFile: (entryId: string, path: string) => Promise<GitReviewFileContent>
}

export function GitPanel({
  cwd,
  projectKey = cwd,
  bridge,
  refreshToken,
  turnChanges,
  previousTurnChanges,
  selectedPath,
  selectionRevision = 0,
  onOpenFile,
}: {
  cwd: string
  projectKey?: string
  bridge: GitReviewBridge
  refreshToken: number
  turnChanges?: TurnChanges
  previousTurnChanges?: TurnChanges
  selectedPath?: string
  selectionRevision?: number
  onOpenFile?: (absolutePath: string) => Promise<void>
}) {
  const storageKey = projectReviewKey(projectKey)
  const [preferences, setPreferences] = useState(() => ({
    ...readProjectReview(storageKey),
    ...(selectionRevision ? { scope: 'turn' as const } : {}),
  }))
  const [revision, setRevision] = useState(selectionRevision)
  const [reading, setReading] = useState(readReadingPreferences)
  const [snapshot, setSnapshot] = useState<GitReviewSnapshot>()
  const [openPaths, setOpenPaths] = useState<Set<string>>(() => new Set(selectedPath ? [selectedPath] : []))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [generation, setGeneration] = useState(0)
  const [width, setWidth] = useState(0)
  const panel = useRef<HTMLDivElement>(null)
  const request = useRef(0)
  const bridgeRef = useRef(bridge)
  bridgeRef.current = bridge
  const scope = preferences.scope
  const agentScope = scope === 'turn' || scope === 'previous-turn'
  const changes = scope === 'previous-turn' ? previousTurnChanges : turnChanges
  const ref = scope === 'branch' ? preferences.branch : scope === 'commit' ? preferences.commit : undefined
  const query = useMemo<GitReviewQuery | undefined>(
    () => (scope === 'turn' || scope === 'previous-turn' ? undefined : { scope, ...(ref ? { ref } : {}) }),
    [scope, ref],
  )
  const queryKey = `${scope}:${ref ?? ''}`
  const [snapshotKey, setSnapshotKey] = useState('')
  const currentSnapshot = snapshotKey === queryKey ? snapshot : undefined
  if (revision !== selectionRevision) {
    setRevision(selectionRevision)
    setPreferences((value) => ({ ...value, scope: 'turn' }))
    setOpenPaths(new Set(selectedPath ? [selectedPath] : []))
  }
  function select(value: ProjectReviewPreferences) {
    setPreferences(value)
    saveReviewPreferences(storageKey, value)
    setOpenPaths(new Set())
    setError('')
  }
  useEffect(() => {
    const element = panel.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (scope !== 'branch' && scope !== 'commit') return
    if (ref) return
    let cancelled = false
    void bridgeRef.current
      .options({})
      .then((options) => {
        if (cancelled) return
        if (options.error) {
          setSnapshot({ cwd, root: cwd, files: [], insertions: 0, deletions: 0, error: options.error })
          setSnapshotKey(queryKey)
          return
        }
        const value = scope === 'branch' ? options.upstream : options.commits[0]?.sha
        if (!value) return
        setPreferences((current) => {
          const next = { ...current, [scope]: value }
          saveReviewPreferences(storageKey, next)
          return next
        })
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [scope, ref, storageKey, cwd, queryKey])
  const refresh = useCallback(async () => {
    const id = ++request.current
    if (!query || ((query.scope === 'branch' || query.scope === 'commit') && !query.ref)) {
      setLoading(false)
      setGeneration((value) => value + 1)
      return
    }
    setLoading(true)
    try {
      const result = await bridgeRef.current.review(query)
      if (id !== request.current) return
      setSnapshot(result)
      setSnapshotKey(queryKey)
      setError('')
      setGeneration((value) => value + 1)
    } catch (cause) {
      if (id === request.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (id === request.current) setLoading(false)
    }
  }, [query, queryKey])
  useEffect(() => {
    void refresh()
    const focus = () => void refresh()
    const timer = window.setInterval(focus, 10000)
    window.addEventListener('focus', focus)
    return () => {
      request.current++
      window.clearInterval(timer)
      window.removeEventListener('focus', focus)
    }
  }, [refresh, refreshToken])
  useEffect(() => {
    if (!selectedPath || scope !== 'turn') return
    const row = Array.from(panel.current?.querySelectorAll<HTMLElement>('[data-review-path]') ?? []).find(
      (element) => element.dataset.reviewPath === selectedPath,
    )
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [selectionRevision, selectedPath, scope])
  const files: GitReviewFile[] = agentScope
    ? (changes?.files ?? []).map((file) => ({
        path: file.path,
        status: file.status ?? 'M',
        insertions: file.insertions,
        deletions: file.deletions,
        canOpen: file.canOpen !== false,
      }))
    : (currentSnapshot?.files ?? [])
  const allExpanded = files.length > 0 && files.every((file) => openPaths.has(file.path))
  const split = reading.layout === 'split' || (reading.layout === 'auto' && width >= 760)
  const total = agentScope ? changes : currentSnapshot
  const toggle = (path: string) =>
    setOpenPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  const root = currentSnapshot?.root ?? cwd
  return (
    <div ref={panel} className="@container flex h-full min-h-0 min-w-0 flex-col">
      <GitReviewToolbar
        scope={scope}
        onScope={(scope) => select({ ...preferences, scope })}
        insertions={total?.insertions ?? 0}
        deletions={total?.deletions ?? 0}
        loading={loading}
        onRefresh={() => void refresh()}
        allExpanded={allExpanded}
        onExpand={() => setOpenPaths(allExpanded ? new Set() : new Set(files.map((file) => file.path)))}
        reading={reading}
        onReading={(value) => {
          setReading(value)
          saveReadingPreferences(value)
        }}
      >
        {(scope === 'branch' || scope === 'commit') && (
          <ReviewTargetPicker
            kind={scope}
            value={ref}
            branch={currentSnapshot?.branch}
            load={(input) => bridgeRef.current.options(input)}
            onSelect={(value) => select({ ...preferences, [scope]: value })}
          />
        )}
      </GitReviewToolbar>
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 text-[11px] text-muted-foreground">
        <span>
          {files.length} 个文件{agentScope && changes?.undone ? ' · 已撤销' : ''}
        </span>
        <span className="truncate">
          {scope === 'branch'
            ? '从共同祖先到当前分支'
            : scope === 'commit'
              ? '本次提交引入的修改'
              : agentScope
                ? 'Agent 文件修改'
                : currentSnapshot?.branch}
        </span>
      </div>
      {error && (
        <div role="alert" className="flex items-start gap-2 border-y border-border px-3 py-2 text-xs text-destructive">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button type="button" onClick={() => void refresh()} className="shrink-0 underline">
            重试
          </button>
        </div>
      )}
      {feedback && (
        <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">
          {feedback}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" aria-busy={loading}>
        {files.map((file) => (
          <ReviewFile
            key={`${queryKey}:${agentScope ? changes?.entryId : ''}:${file.path}`}
            file={file}
            open={openPaths.has(file.path)}
            onToggle={() => toggle(file.path)}
            split={split}
            wrap={reading.wrap}
            generation={generation}
            absolutePath={
              agentScope
                ? (changes?.files.find((item) => item.path === file.path)?.absolutePath ?? joinPath(cwd, file.path))
                : joinPath(root, file.path)
            }
            onOpenFile={onOpenFile}
            feedback={setFeedback}
            load={() =>
              agentScope
                ? bridgeRef.current.turnFile(changes!.entryId, file.path)
                : bridgeRef.current.file({ query: query!, path: file.path })
            }
            initial={agentScope ? changes?.files.find((item) => item.path === file.path)?.patch : undefined}
          />
        ))}
        {currentSnapshot?.error && (
          <div className="px-5 py-8 text-center text-xs leading-6 text-muted-foreground">
            <p>{currentSnapshot.error === 'not-repository' ? '当前项目未使用 Git。' : '当前环境未安装 Git。'}</p>
            <p>Agent 的本轮和上一轮修改仍可查看。</p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => select({ ...preferences, scope: 'turn' })}
            >
              查看 Agent 本轮修改
            </Button>
          </div>
        )}
        {!files.length && !error && !currentSnapshot?.error && (
          <p className="px-5 py-10 text-center text-xs leading-6 text-muted-foreground">
            {loading
              ? '正在读取变更…'
              : (scope === 'branch' || scope === 'commit') && !ref
                ? `请选择${scope === 'branch' ? '比较分支' : '提交'}`
                : agentScope
                  ? `${scope === 'turn' ? '本轮' : '上一轮'}没有 Agent 文件修改记录。`
                  : scope === 'uncommitted'
                    ? '工作区干净'
                    : '此范围没有文件变更'}
          </p>
        )}
      </div>
    </div>
  )
}

function joinPath(root: string, file: string) {
  return `${root.replace(/[\\/]$/, '')}/${file}`
}
const statuses: Record<string, string> = {
  A: '新增',
  D: '删除',
  R: '重命名',
  C: '复制',
  M: '修改',
  '?': '未跟踪',
  T: '类型变化',
  U: '冲突',
}

function ReviewFile({
  file,
  open,
  onToggle,
  split,
  wrap,
  generation,
  absolutePath,
  onOpenFile,
  feedback,
  load,
  initial,
}: {
  file: GitReviewFile
  open: boolean
  onToggle: () => void
  split: boolean
  wrap: boolean
  generation: number
  absolutePath: string
  onOpenFile?: (path: string) => Promise<void>
  feedback: (message: string) => void
  load: () => Promise<GitReviewFileContent>
  initial?: string
}) {
  const [content, setContent] = useState<GitReviewFileContent | undefined>(() =>
    initial === undefined ? undefined : { patch: initial },
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (!open) return
    let current = true
    setLoading(true)
    void loadRef
      .current()
      .then((result) => {
        if (current) {
          setContent(result)
          setError('')
        }
      })
      .catch((cause) => {
        if (current) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [open, generation, retry, initial])
  const slash = Math.max(file.path.lastIndexOf('/'), file.path.lastIndexOf('\\'))
  const directory = file.path.slice(0, slash + 1)
  const name = file.path.slice(slash + 1)
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      feedback(`已复制${label}`)
    } catch {
      feedback('复制失败，请检查剪贴板权限后重试。')
    }
  }
  async function copyDiff() {
    try {
      const value = content ?? (await loadRef.current())
      if (value.notice) {
        feedback(value.notice)
        return
      }
      await copy(value.patch, ' Diff')
    } catch (cause) {
      feedback(`读取 Diff 失败：${String(cause)}`)
    }
  }
  const openFile = () => {
    if (onOpenFile) void onOpenFile(absolutePath).catch((cause) => feedback(`打开文件失败：${String(cause)}`))
  }
  return (
    <section data-review-path={file.path} className="border-b border-border/60">
      <div
        className={cn('group flex min-w-0 items-center gap-1 px-2 hover:bg-secondary/40', open && 'bg-secondary/25')}
      >
        <button
          type="button"
          aria-label={file.path}
          aria-expanded={open}
          onClick={onToggle}
          title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
          className="flex min-w-0 flex-1 items-center gap-2 rounded py-3 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring"
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )}
          <FileIcon path={file.path} />
          <span className="flex min-w-0 flex-1 items-baseline overflow-hidden">
            <span className="min-w-0 truncate text-muted-foreground">{directory}</span>
            <span className="max-w-full shrink-0 truncate font-medium">{name}</span>
          </span>
          {file.status !== 'M' && (
            <span className="shrink-0 text-[10px] text-muted-foreground" title={statuses[file.status] ?? file.status}>
              {file.status === '?' ? '新' : file.status}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">
              {file.insertions === null ? '—' : `+${file.insertions}`}
            </span>
            <span className="text-rose-600 dark:text-rose-400">
              {file.deletions === null ? '—' : `−${file.deletions}`}
            </span>
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="hidden size-7 shrink-0 text-muted-foreground @min-[600px]:inline-flex"
          title={file.canOpen ? '在编辑器中打开' : '当前工作区中无法打开此文件'}
          aria-label={`在编辑器中打开 ${file.path}`}
          disabled={!onOpenFile || !file.canOpen}
          onClick={openFile}
        >
          <ExternalLink className="size-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 shrink-0 text-muted-foreground"
              aria-label={`${file.path} 的更多操作`}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom">
            <DropdownMenuItem onSelect={() => void copy(file.path, '相对路径')}>
              <Copy />
              复制相对路径
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copy(absolutePath, '绝对路径')}>复制绝对路径</DropdownMenuItem>
            <DropdownMenuItem
              disabled={!onOpenFile || !file.canOpen}
              title={
                !file.canOpen ? '当前工作区中无法打开此文件' : !onOpenFile ? '当前连接不支持本机编辑器' : undefined
              }
              onSelect={openFile}
            >
              <ExternalLink />
              在编辑器中打开
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onToggle}>{open ? '收起差异' : '展开差异'}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copyDiff()}>复制 Diff</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && (
        <>
          {loading && !content && (
            <p role="status" className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
              <RefreshCw className="size-3 animate-spin" />
              正在读取差异…
            </p>
          )}
          {error && (
            <p role="alert" className="px-4 py-2 text-xs text-destructive">
              {error}
              <button type="button" onClick={() => setRetry((value) => value + 1)} className="ml-2 underline">
                重试
              </button>
            </p>
          )}
          {content && (
            <GitDiffViewer
              diff={content.patch}
              path={file.path}
              before={content.before}
              after={content.after}
              notice={content.notice}
              split={split}
              wrap={wrap}
            />
          )}
        </>
      )}
    </section>
  )
}
