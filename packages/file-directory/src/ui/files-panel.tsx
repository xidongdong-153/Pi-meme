import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronRight, PanelLeft, RefreshCw, Save, Search } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { FileEntry, WorkspaceRef } from '@pi-meme/contracts/app-host'
import type { UiContributionProps } from '@pi-meme/plugin-sdk/ui'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { FileIcon } from '@pi-meme/ui/components/file-icon'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@pi-meme/ui/components/ui/dialog'
import { cn } from '@pi-meme/ui/lib/utils'
import { type FileStore, fileDirty } from './file-store'

const FileEditor = lazy(() => import('./file-editor').then((module) => ({ default: module.FileEditor })))

export function FilesPanel({ store, target }: Pick<UiContributionProps, 'target'> & { store: FileStore }) {
  const hostId = target.session?.hostId ?? target.project?.hostId ?? target.hostId
  const sessionId = target.session?.sessionId
  const projectId = target.project?.projectId
  const root = useMemo(
    () => (sessionId ? { hostId, sessionId } : projectId ? { hostId, projectId } : undefined),
    [hostId, sessionId, projectId],
  )
  if (!root) return <p className="p-5 text-sm text-muted-foreground">请选择项目或会话。</p>
  return <Browser key={JSON.stringify(root)} store={store} root={root} />
}
function Browser({ store, root }: { store: FileStore; root: WorkspaceRef }) {
  const state = useSyncExternalStore(store.subscribe, () => store.state(root))
  const [pending, setPending] = useState<string>()
  const [editingPath, setEditingPath] = useState<string>()
  const preview = editingPath !== state.selected
  const [treeWidth, setTreeWidth] = useState(176)
  const treeRef = useRef<HTMLElement>(null)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const [resizing, setResizing] = useState(false)
  const dirty = fileDirty(state)
  useEffect(() => {
    void store.loadDirectory(root)
  }, [store, root])
  useEffect(() => {
    const timer = setTimeout(() => {
      void store.search(root, state.query)
    }, 250)
    return () => clearTimeout(timer)
  }, [store, root, state.query])
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (store.canWrite(store.state(root))) void store.save(root)
      }
    }
    window.addEventListener('keydown', save)
    return () => window.removeEventListener('keydown', save)
  }, [store, root])
  function choose(path: string) {
    if (dirty) setPending(path)
    else {
      setEditingPath(undefined)
      void store.select(root, path)
    }
  }
  const markdown = /\.(?:md|markdown|mdx)$/i.test(state.selected)
  return (
    <section aria-label="文件工具" className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/70 px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={state.treeHidden ? '展开文件目录' : '收起文件目录'}
          onClick={() => store.update(root, { treeHidden: !state.treeHidden })}
        >
          <PanelLeft className="size-4" />
        </Button>
        <span className="min-w-0 flex-1 truncate" title={state.selected}>
          {state.selected || '项目文件'}
          {dirty && <span className="ml-2 text-primary">未保存</span>}
        </span>
        {state.preview?.kind === 'text' && store.canWrite(state) && (
          <Button size="sm" variant="ghost" onClick={() => setEditingPath(preview ? state.selected : undefined)}>
            {preview ? '编辑' : '预览'}
          </Button>
        )}
        {state.selected && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="重新读取文件"
            disabled={state.loading || state.saving}
            onClick={() => choose(state.selected)}
          >
            <RefreshCw className={cn('size-3.5', state.loading && 'animate-spin')} />
          </Button>
        )}
        {store.canWrite(state) && (!preview || dirty) && (
          <Button size="sm" variant="ghost" disabled={!dirty || state.saving} onClick={() => void store.save(root)}>
            <Save className="size-3.5" />
            {state.saving ? '保存中' : '保存'}
          </Button>
        )}
      </div>
      {state.error && (
        <p role="alert" className="shrink-0 break-words border-b border-border px-3 py-2 text-destructive">
          {state.error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <aside
          ref={treeRef}
          aria-label="文件目录"
          aria-hidden={state.treeHidden}
          inert={state.treeHidden}
          style={{ width: state.treeHidden ? 0 : treeWidth }}
          className={cn(
            'relative flex min-w-0 max-w-[60%] shrink-0 flex-col',
            !resizing && 'transition-[width] duration-200 ease-out motion-reduce:transition-none',
          )}
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-r border-border/70">
            <div className="flex items-center gap-1 border-b border-border/60 p-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" />
                <Input
                  aria-label="搜索文件名"
                  placeholder="搜索文件名"
                  value={state.query}
                  disabled={!store.capabilities?.fileOperations?.includes('search')}
                  onChange={(event) => store.update(root, { query: event.target.value })}
                  className="h-8 rounded-lg bg-secondary/40 pl-7 text-xs"
                />
              </div>
              <Button variant="ghost" size="icon-sm" aria-label="刷新文件目录" onClick={() => void store.refresh(root)}>
                <RefreshCw className="size-3.5" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto py-1">
              {state.query.trim() ? (
                <>
                  {state.matches.map((entry) => (
                    <button
                      key={entry.relativePath}
                      type="button"
                      onClick={() => choose(entry.relativePath)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-secondary/50',
                        state.selected === entry.relativePath && 'bg-primary/15 text-foreground',
                      )}
                      title={entry.relativePath}
                    >
                      <FileIcon path={entry.name} />
                      <span className="min-w-0">
                        <span className="block truncate">{entry.name}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">{entry.relativePath}</span>
                      </span>
                    </button>
                  ))}
                  {state.searching && (
                    <p role="status" className="p-3 text-muted-foreground">
                      正在搜索…
                    </p>
                  )}
                  {!state.searching && !state.matches.length && (
                    <p className="p-3 text-muted-foreground">没有匹配的文件。</p>
                  )}
                  {state.nextCursor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={state.searching}
                      onClick={() => void store.search(root, state.query, true)}
                    >
                      加载更多
                    </Button>
                  )}
                </>
              ) : (
                <Directory store={store} root={root} path="" choose={choose} depth={0} />
              )}
            </div>
          </div>
          {!state.treeHidden && (
            <div
              role="separator"
              aria-label="调整文件目录宽度"
              aria-orientation="vertical"
              aria-valuemin={112}
              aria-valuemax={480}
              aria-valuenow={treeWidth}
              tabIndex={0}
              className="absolute inset-y-0 right-0 z-10 w-2 translate-x-1/2 touch-none cursor-col-resize hover:bg-primary/20 focus-visible:bg-primary/20 focus-visible:outline-none"
              onPointerDown={(event) => {
                if (event.button !== 0) return
                event.preventDefault()
                event.currentTarget.setPointerCapture(event.pointerId)
                drag.current = { x: event.clientX, width: treeRef.current!.getBoundingClientRect().width }
                setResizing(true)
              }}
              onPointerMove={(event) => {
                if (!drag.current) return
                const max = Math.min(480, (treeRef.current?.parentElement?.clientWidth ?? 800) * 0.6)
                setTreeWidth(Math.min(max, Math.max(112, drag.current.width + event.clientX - drag.current.x)))
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId)
                }
                drag.current = null
                setResizing(false)
              }}
              onLostPointerCapture={() => {
                drag.current = null
                setResizing(false)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                const max = Math.min(480, (treeRef.current?.parentElement?.clientWidth ?? 800) * 0.6)
                setTreeWidth((width) => Math.min(max, Math.max(112, width + (event.key === 'ArrowRight' ? 16 : -16))))
              }}
            />
          )}
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {state.loading ? (
            <p role="status" className="p-5 text-muted-foreground">
              正在读取文件…
            </p>
          ) : state.preview?.kind === 'text' ? (
            markdown && preview ? (
              <div className="file-markdown overflow-auto p-5 text-sm select-text">
                <Markdown remarkPlugins={[remarkGfm]}>{state.draft}</Markdown>
              </div>
            ) : (
              <Suspense
                fallback={
                  <p role="status" className="p-5 text-muted-foreground">
                    正在加载编辑器…
                  </p>
                }
              >
                <FileEditor
                  key={`${state.selected}:${state.loadId}`}
                  path={state.selected}
                  content={state.draft}
                  editable={!preview && store.canWrite(state)}
                  onChange={(value) => store.edit(root, value)}
                />
              </Suspense>
            )
          ) : state.preview?.kind === 'image' ? (
            <ImagePreview key={state.selected} src={state.preview.dataUrl} size={state.preview.size} />
          ) : state.preview?.kind === 'unsupported' ? (
            <p className="p-5 text-muted-foreground">
              {state.preview.reason === 'too-large'
                ? '文件过大，文本上限为 1 MiB，图片上限为 8 MiB。'
                : state.preview.reason === 'encoding'
                  ? '文件不是有效的 UTF-8 文本，暂不支持预览。'
                  : '二进制文件暂不支持预览。'}
            </p>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
              <FileIcon path="" directory expanded className="size-8" />
              <p>选择文件以查看内容。</p>
            </div>
          )}
        </div>
      </div>
      <Dialog
        open={pending !== undefined}
        onOpenChange={(open) => {
          if (!open) setPending(undefined)
        }}
      >
        <DialogContent>
          <DialogTitle>当前文件有未保存的修改</DialogTitle>
          <DialogDescription>保存后继续，或丢弃修改并打开文件。</DialogDescription>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setPending(undefined)}>
              取消
            </Button>
            <Button
              variant="outline"
              disabled={state.saving}
              onClick={() => {
                const path = pending!
                setPending(undefined)
                setEditingPath(undefined)
                void store.select(root, path)
              }}
            >
              丢弃修改
            </Button>
            <Button
              disabled={state.saving}
              onClick={async () => {
                const path = pending!
                if ((await store.save(root)) && !fileDirty(store.state(root))) {
                  setPending(undefined)
                  setEditingPath(undefined)
                  await store.select(root, path)
                }
              }}
            >
              保存并继续
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
function Directory({
  store,
  root,
  path,
  choose,
  depth,
}: {
  store: FileStore
  root: WorkspaceRef
  path: string
  choose: (path: string) => void
  depth: number
}) {
  const state = useSyncExternalStore(store.subscribe, () => store.state(root))
  useEffect(() => {
    void store.loadDirectory(root, path)
  }, [store, root, path])
  const entries = state.entries[path]
  if (!entries) return <p className="px-3 py-2 text-muted-foreground">正在读取目录…</p>
  return (
    <ul>
      {entries.map((entry) => (
        <Entry key={entry.relativePath} store={store} root={root} entry={entry} choose={choose} depth={depth} />
      ))}
    </ul>
  )
}
function Entry({
  store,
  root,
  entry,
  choose,
  depth,
}: {
  store: FileStore
  root: WorkspaceRef
  entry: FileEntry
  choose: (path: string) => void
  depth: number
}) {
  const state = store.state(root)
  const directory = entry.kind === 'directory'
  const expanded = state.expanded.includes(entry.relativePath)
  const [visited, setVisited] = useState(expanded)
  return (
    <li>
      <button
        type="button"
        aria-label={`${directory ? '目录' : '打开文件'}：${entry.relativePath}`}
        aria-expanded={directory ? expanded : undefined}
        aria-current={!directory && state.selected === entry.relativePath ? 'true' : undefined}
        onClick={() => {
          if (directory) {
            setVisited(true)
            store.toggleDirectory(root, entry.relativePath)
          } else choose(entry.relativePath)
        }}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={cn(
          'flex h-8 w-full items-center gap-1.5 pr-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
          !directory && state.selected === entry.relativePath
            ? 'bg-primary/15 font-medium text-foreground'
            : 'hover:bg-secondary/50',
        )}
        title={entry.relativePath}
      >
        {directory ? (
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
              expanded && 'rotate-90',
            )}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <FileIcon path={entry.name} directory={directory} expanded={expanded} />
        <span className="truncate">{entry.name}</span>
      </button>
      {directory && (
        <div
          aria-hidden={!expanded}
          inert={!expanded}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
            expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="min-h-0 overflow-hidden">
            {(visited || expanded) && (
              <Directory store={store} root={root} path={entry.relativePath} choose={choose} depth={depth + 1} />
            )}
          </div>
        </div>
      )}
    </li>
  )
}
function ImagePreview({ src, size }: { src: string; size: number }) {
  const [actual, setActual] = useState(false)
  const [dimensions, setDimensions] = useState('')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="file-image-stage flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img
          src={src}
          alt="文件预览"
          className={actual ? 'max-w-none shrink-0' : 'max-h-full max-w-full object-contain'}
          onLoad={(event) => {
            const image = event.currentTarget
            setDimensions(`${image.naturalWidth} × ${image.naturalHeight}`)
          }}
        />
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-border px-3 py-2 text-muted-foreground">
        <span>
          {dimensions} · {(size / 1024).toFixed(1)} KiB
        </span>
        <Button size="sm" variant="ghost" onClick={() => setActual(!actual)}>
          {actual ? '适应窗口' : '实际大小'}
        </Button>
      </div>
    </div>
  )
}
