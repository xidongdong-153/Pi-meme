import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileDiff, RefreshCw } from 'lucide-react'
import type { GitBridge, GitFileChange, GitSnapshot } from '@pi-meme/contracts/desktop'
import { Button } from '@pi-meme/ui/components/ui/button'
import { GitDiffViewer } from './git-diff-viewer'
import type { TurnChanges } from '@pi-meme/contracts/turn-changes'

const sections: Array<{ kind: GitFileChange['kind']; title: string }> = [
  { kind: 'staged', title: '已暂存' },
  { kind: 'unstaged', title: '未暂存' },
  { kind: 'untracked', title: '未跟踪' },
]

export function GitPanel({
  cwd,
  bridge,
  refreshToken,
  turnChanges,
  selectedPath,
  selectionRevision = 0,
}: {
  cwd: string
  bridge: Pick<GitBridge, 'getGitSnapshot' | 'getGitDiff'>
  refreshToken: number
  turnChanges?: TurnChanges
  selectedPath?: string
  selectionRevision?: number
}) {
  const [selection, setSelection] = useState({ revision: selectionRevision, mode: 'turn' as 'turn' | 'workspace' })
  if (selection.revision !== selectionRevision) setSelection({ revision: selectionRevision, mode: 'turn' })
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-2">
        <div className="flex rounded-md bg-secondary/60 p-0.5">
          {(
            [
              ['turn', '本轮'],
              ['workspace', '工作区'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={selection.mode === value}
              onClick={() => setSelection({ revision: selectionRevision, mode: value })}
              className={`rounded px-2 py-0.5 text-[0.6875rem] ${selection.mode === value ? 'bg-background font-medium text-foreground' : 'text-muted-foreground'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {selection.mode === 'turn' ? (
        <TurnReview key={selectionRevision} changes={turnChanges} selectedPath={selectedPath} />
      ) : (
        <WorkspaceChanges cwd={cwd} bridge={bridge} refreshToken={refreshToken} />
      )}
    </div>
  )
}

function TurnReview({ changes, selectedPath }: { changes?: TurnChanges; selectedPath?: string }) {
  const [openPath, setOpenPath] = useState<string | null>(selectedPath ?? null)
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <span>
          {changes?.files.length ?? 0} 个文件{changes?.undone ? ' · 已撤销' : ''}
        </span>
        {changes && (
          <>
            <span className="font-mono text-emerald-600 dark:text-emerald-400">+{changes.insertions}</span>
            <span className="font-mono text-rose-600 dark:text-rose-400">−{changes.deletions}</span>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!changes?.files.length ? (
          <p className="px-3 py-5 text-center text-xs text-muted-foreground">
            本轮没有可用的文件变更记录。旧会话未保存的修改前内容无法恢复。
          </p>
        ) : (
          changes.files.map((file) => (
            <div key={file.path} className="border-b border-border/30">
              <button
                type="button"
                aria-label={file.path}
                aria-expanded={openPath === file.path}
                onClick={() => setOpenPath(openPath === file.path ? null : file.path)}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {openPath === file.path ? (
                  <ChevronDown className="size-3 shrink-0" />
                ) : (
                  <ChevronRight className="size-3 shrink-0" />
                )}
                <FileDiff className="size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate" title={file.path}>
                  {file.path}
                </span>
                <span className="font-mono text-emerald-600 dark:text-emerald-400">+{file.insertions}</span>
                <span className="font-mono text-rose-600 dark:text-rose-400">−{file.deletions}</span>
              </button>
              {openPath === file.path && (
                <div className="border-t border-border/40 px-2 py-1">
                  <GitDiffViewer diff={file.patch} />
                </div>
              )}
            </div>
          ))
        )}
      </div>
      <p className="shrink-0 border-t border-border/60 px-3 py-2 text-[0.625rem] leading-relaxed text-muted-foreground">
        只记录本会话本轮 edit / write 的修改，包括 codemode 内的调用。
      </p>
    </>
  )
}

function WorkspaceChanges({
  cwd,
  bridge,
  refreshToken,
}: {
  cwd: string
  bridge: Pick<GitBridge, 'getGitSnapshot' | 'getGitDiff'>
  refreshToken: number
}) {
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null)
  const [selected, setSelected] = useState<GitFileChange | null>(null)
  const [diff, setDiff] = useState('')
  const [loading, setLoading] = useState(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const requestId = useRef(0)
  const diffId = useRef(0)
  const inFlight = useRef(false)
  const bridgeRef = useRef(bridge)
  bridgeRef.current = bridge
  const lastToken = useRef(refreshToken)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    const id = ++requestId.current
    setLoading(true)
    try {
      const next = await bridgeRef.current.getGitSnapshot()
      if (id !== requestId.current || next.cwd !== cwd) return
      setSnapshot(next)
      setSelected((current) =>
        current && next.files.some((file) => file.path === current.path && file.kind === current.kind) ? current : null,
      )
    } catch {
      if (id === requestId.current) setSnapshot({ cwd, files: [], insertions: 0, deletions: 0, error: 'failed' })
    } finally {
      if (id === requestId.current) setLoading(false)
      inFlight.current = false
    }
  }, [cwd])

  useEffect(() => {
    setSnapshot(null)
    setSelected(null)
    setDiff('')
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    const focus = () => void refresh()
    window.addEventListener('focus', focus)
    return () => {
      requestId.current += 1
      window.clearInterval(timer)
      window.removeEventListener('focus', focus)
    }
  }, [refresh])

  useEffect(() => {
    if (lastToken.current === refreshToken) return
    lastToken.current = refreshToken
    void refresh()
  }, [refreshToken, refresh])

  useEffect(() => {
    if (!selected) {
      setDiff('')
      return
    }
    const id = ++diffId.current
    setDiff('')
    setDiffLoading(true)
    void bridgeRef.current
      .getGitDiff(selected.path, selected.kind)
      .then((value) => {
        if (id === diffId.current) setDiff(value)
      })
      .catch((cause: unknown) => {
        if (id === diffId.current) setDiff(`读取变更失败：${String(cause)}`)
      })
      .finally(() => {
        if (id === diffId.current) setDiffLoading(false)
      })
    return () => {
      diffId.current += 1
    }
  }, [selected, cwd])

  const message =
    snapshot?.error === 'unavailable'
      ? '未找到 Git，请先安装 Git。'
      : snapshot?.error === 'not-repository'
        ? '当前项目不在 Git 仓库中。'
        : snapshot?.error === 'failed'
          ? '读取 Git 状态失败。'
          : null

  const fileCount = new Set(snapshot?.files.map((file) => file.path) ?? []).size

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2 text-[0.6875rem]">
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={snapshot?.root ?? cwd}>
          {snapshot?.branch ?? snapshot?.root ?? cwd}
        </span>
        <span className="shrink-0 text-muted-foreground">{fileCount} 个变更</span>
        <span className="shrink-0 font-mono text-emerald-500">+{snapshot?.insertions ?? 0}</span>
        <span className="shrink-0 font-mono text-rose-500">−{snapshot?.deletions ?? 0}</span>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => void refresh()}
          aria-label="刷新 Git 变更"
          title="刷新"
          className="shrink-0"
        >
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      {message ? (
        <div className="px-3 py-4 text-xs text-muted-foreground">{message}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {sections.map(({ kind, title }) => {
            const files = snapshot?.files.filter((file) => file.kind === kind) ?? []
            if (!files.length) return null
            return (
              <section key={kind} className="py-2">
                <h3 className="px-3 pb-1 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
                  {title} · {files.length}
                </h3>
                <div className="divide-y divide-border/20">
                  {files.map((file) => {
                    const active = selected?.path === file.path && selected.kind === file.kind
                    return (
                      <div key={`${kind}:${file.path}`} className="flex flex-col">
                        <button
                          type="button"
                          onClick={() => setSelected(active ? null : file)}
                          aria-expanded={active}
                          className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[0.6875rem] transition-colors hover:bg-secondary/70 ${active ? 'bg-secondary/80 font-medium' : ''}`}
                        >
                          {active ? (
                            <ChevronDown className="size-3 shrink-0" />
                          ) : (
                            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                          )}
                          <FileDiff className="size-3 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate" title={file.path}>
                            {file.path}
                          </span>
                          <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground">
                            {file.status}
                          </span>
                        </button>
                        {active && (
                          <div className="border-t border-border/40 bg-muted/15 pb-2 pt-1">
                            {diffLoading ? (
                              <div className="flex items-center gap-2 px-4 py-3 text-[0.6875rem] text-muted-foreground">
                                <RefreshCw className="size-3 shrink-0 animate-spin" />
                                <span>正在读取 Diff…</span>
                              </div>
                            ) : (
                              <GitDiffViewer diff={diff} isUntracked={file.kind === 'untracked'} />
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}
          {!message && snapshot?.files.length === 0 && (
            <div className="px-3 py-5 text-center text-xs text-muted-foreground">工作区干净</div>
          )}
        </div>
      )}
    </>
  )
}
