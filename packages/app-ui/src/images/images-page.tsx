import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, ExternalLink, Images, Info, MoreHorizontal, Pencil, RefreshCw, Search, Trash2 } from 'lucide-react'
import type { SessionRef } from '@pi-meme/contracts/app-host'
import { ImageViewer } from '@pi-meme/chat/ui/content/image-viewer'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@pi-meme/ui/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import {
  GalleryImageLoader,
  ImageLibraryFeed,
  compareImages,
  galleryKey,
  imageMasonry,
  type GalleryImage,
  type ImageLibrarySource,
} from './image-library-data'

function ImageTile({
  item,
  source,
  loader,
  root,
  onOpen,
  onAction,
}: {
  item: GalleryImage
  source: ImageLibrarySource
  loader: GalleryImageLoader
  root: HTMLDivElement | null
  onOpen: (button: HTMLButtonElement) => void
  onAction: (action: 'rename' | 'remove' | 'download' | 'source' | 'info') => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root, rootMargin: '400px' })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [root])
  useEffect(() => {
    let cancelled = false
    if (!near) {
      setUrl('')
      return
    }
    setError('')
    void loader
      .load(item, source)
      .then((value) => {
        if (!cancelled) setUrl(value)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '图片加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [near, item.id, item.serviceId, loader, source.host, source.connected, retry])
  return (
    <div ref={ref} className="group relative h-full overflow-hidden rounded-2xl bg-secondary">
      <button
        type="button"
        className="relative flex size-full items-center justify-center overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        style={{
          backgroundImage:
            'conic-gradient(from 90deg, transparent 25%, rgb(127 127 127 / 0.12) 0 50%, transparent 0 75%, rgb(127 127 127 / 0.12) 0)',
          backgroundSize: '20px 20px',
        }}
        aria-label={`查看图像：${item.name}`}
        onClick={(event) => {
          if (error) {
            loader.invalidate(item)
            setUrl('')
            setRetry((value) => value + 1)
          } else onOpen(event.currentTarget)
        }}
      >
        {url ? (
          <img
            src={url}
            alt={item.name}
            className="size-full object-contain"
            onError={() => setError('图片无法显示，点击重试')}
          />
        ) : (
          <span className="px-4 text-center text-xs text-muted-foreground">{error || '正在加载图片…'}</span>
        )}
        {error && url && (
          <span className="absolute inset-0 flex items-center justify-center bg-background/90 p-4 text-xs">
            {error}
          </span>
        )}
        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-4 pb-3 pt-10 text-left text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <span className="block truncate text-sm font-medium">{item.name}</span>
          <span className="block truncate text-xs text-white/70">
            {item.projectName || '独立聊天'} · {item.hostLabel}
          </span>
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${item.name}的操作`}
            className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-black/80 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="bottom" className="w-44">
          <DropdownMenuItem onSelect={() => onAction('info')}>
            <Info className="size-4" />
            查看信息
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onAction('source')}>
            <ExternalLink className="size-4" />
            打开来源会话
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onAction('rename')}>
            <Pencil className="size-4" />
            重命名
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onAction('download')}>
            <Download className="size-4" />
            下载
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onAction('remove')}>
            <Trash2 className="size-4" />
            从图像中移除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function ImagesPage({
  sources,
  visible,
  onOpenSession,
}: {
  sources: ImageLibrarySource[]
  visible: boolean
  onOpenSession: (serviceId: string, ref: SessionRef) => Promise<void>
}) {
  const [hostFilter, setHostFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<GalleryImage[]>([])
  const [feed, setFeed] = useState<ImageLibraryFeed>()
  const [loading, setLoading] = useState(false)
  const [more, setMore] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [dialog, setDialog] = useState<{ action: 'rename' | 'remove' | 'info'; item: GalleryImage }>()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [name, setName] = useState('')
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({})
  const trigger = useRef<HTMLButtonElement | null>(null)
  const loader = useMemo(() => new GalleryImageLoader(), [])
  const sourceRef = useRef(sources)
  sourceRef.current = sources
  const itemsRef = useRef(items)
  itemsRef.current = items
  const previewKey = useRef<string | undefined>(undefined)
  previewKey.current = previewIndex === null || !items[previewIndex] ? undefined : galleryKey(items[previewIndex])
  const generation = useRef(0)
  const previewRequest = useRef(0)
  const scroll = useRef<HTMLDivElement>(null)
  const wall = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [refreshRevision, setRefreshRevision] = useState(0)
  const sourceKey = sources.map((source) => `${source.id}:${source.connected}:${source.label}`).join('|')
  const selectedProject =
    projectFilter !== 'all' && projectFilter !== 'standalone'
      ? (JSON.parse(projectFilter) as [string, string])
      : undefined
  const filterKey = `${hostFilter}:${projectFilter}:${query}`
  const previousFilter = useRef(filterKey)
  const refresh = useCallback(() => setRefreshRevision((value) => value + 1), [])

  useEffect(() => {
    const timer = setTimeout(setQuery, 250, search)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => {
    if (!visible || !wall.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(wall.current)
    return () => observer.disconnect()
  }, [visible])
  useEffect(() => {
    if (!visible) {
      previewRequest.current++
      setBusy('')
      setPreviewIndex(null)
      setPreviewUrls({})
      setDialogOpen(false)
      return
    }
    const version = ++generation.current
    const changedFilter = previousFilter.current !== filterKey
    previousFilter.current = filterKey
    if (changedFilter) {
      previewRequest.current++
      setBusy('')
      scroll.current?.scrollTo({ top: 0 })
      setPreviewIndex(null)
      setPreviewUrls({})
    }
    const [projectHost, projectId] = selectedProject ?? []
    const selected = sourceRef.current.filter(
      (source) => (hostFilter === 'all' || source.id === hostFilter) && (!projectHost || source.id === projectHost),
    )
    const next = new ImageLibraryFeed(selected, {
      query,
      projectId: projectFilter === 'standalone' ? 'standalone' : projectId,
    })
    setLoading(true)
    setError('')
    const count = changedFilter ? 40 : Math.max(40, itemsRef.current.length)
    void next
      .more(count)
      .then((result) => {
        if (generation.current !== version) return
        const failed = new Set(next.sources.filter((source) => source.error).map((source) => source.source.id))
        const retained = changedFilter
          ? []
          : itemsRef.current.filter(
              (item) => failed.has(item.serviceId) && !result.some((loaded) => galleryKey(loaded) === galleryKey(item)),
            )
        const currentPreview = previewKey.current
        const combined = [...result, ...retained].sort(compareImages)
        setItems(combined)
        if (currentPreview) {
          const index = combined.findIndex((item) => galleryKey(item) === currentPreview)
          setPreviewIndex(index < 0 ? null : index)
        }
        setFeed(next)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (generation.current === version) {
          setError(String(cause))
          setLoading(false)
        }
      })
    return () => {
      generation.current++
    }
  }, [visible, sourceKey, filterKey, refreshRevision])

  useEffect(() => {
    if (!visible) return
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribes: Array<() => void> = []
    for (const source of sourceRef.current.filter((item) => item.connected)) {
      void source.host.events
        .subscribe({}, (event) => {
          if (event.type !== 'image-library' && event.type !== 'resync') return
          clearTimeout(timer)
          timer = setTimeout(refresh, 300)
        })
        .then((unsubscribe) => (closed ? unsubscribe() : unsubscribes.push(unsubscribe)))
        .catch(() => {})
    }
    return () => {
      closed = true
      clearTimeout(timer)
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  }, [visible, sourceKey, refresh])
  useEffect(() => {
    if (!visible || !feed?.sources.some((source) => source.page?.scan.running)) return
    const timer = setTimeout(refresh, 1000)
    return () => clearTimeout(timer)
  }, [feed, visible, refresh])

  async function loadMore() {
    if (!feed || loading || more) return
    const version = generation.current
    setMore(true)
    try {
      const result = await feed.more()
      if (generation.current === version) {
        const failed = new Set(feed.sources.filter((source) => source.error).map((source) => source.source.id))
        setItems(
          [
            ...result,
            ...itemsRef.current.filter(
              (item) => failed.has(item.serviceId) && !result.some((value) => galleryKey(value) === galleryKey(item)),
            ),
          ].sort(compareImages),
        )
      }
    } finally {
      setMore(false)
    }
  }
  function sourceFor(item: GalleryImage) {
    const source = sourceRef.current.find((source) => source.id === item.serviceId)
    if (!source?.connected || !source.host.imageLibrary) throw new Error('图片所属 Host 未连接')
    return source
  }
  async function preview(index: number | null) {
    const request = ++previewRequest.current
    if (index === null) {
      setPreviewIndex(null)
      setPreviewUrls({})
      return
    }
    const item = items[index]
    if (!item) return
    setBusy(galleryKey(item))
    try {
      const url = await loader.load(item, sourceFor(item))
      if (request !== previewRequest.current) return
      setPreviewUrls({ [galleryKey(item)]: url })
      const currentIndex = itemsRef.current.findIndex((value) => galleryKey(value) === galleryKey(item))
      setPreviewIndex(currentIndex < 0 ? null : currentIndex)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开图片')
    } finally {
      if (request === previewRequest.current) setBusy('')
    }
  }
  async function action(item: GalleryImage, kind: 'rename' | 'remove' | 'download' | 'source' | 'info') {
    if (kind === 'rename' || kind === 'remove' || kind === 'info') {
      setName(item.name)
      setError('')
      setDialog({ action: kind, item })
      setDialogOpen(true)
      return
    }
    setBusy(galleryKey(item))
    setError('')
    try {
      const source = sourceFor(item)
      if (kind === 'source') await onOpenSession(item.serviceId, item.session)
      else {
        const url = await loader.load(item, source)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `${Array.from(item.name)
          .map((character) => (character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character) ? '_' : character))
          .join('')}.png`
        anchor.click()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '图像操作失败')
    } finally {
      setBusy('')
    }
  }
  async function saveDialog() {
    if (!dialogOpen || !dialog || dialog.action === 'info') return
    const { item, action: kind } = dialog
    setBusy(galleryKey(item))
    setError('')
    try {
      const api = sourceFor(item).host.imageLibrary!
      const options = { idempotencyKey: crypto.randomUUID() }
      if (kind === 'rename') await api.rename(item.id, name, options)
      else {
        await api.remove(item.id, options)
        setPreviewIndex(null)
      }
      setDialogOpen(false)
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '图像操作失败')
    } finally {
      setBusy('')
    }
  }
  const layout = useMemo(() => imageMasonry(items, width), [items, width])
  const projects =
    feed?.sources.flatMap(
      (state) =>
        state.page?.projects.map((project) => ({
          value: JSON.stringify([state.source.id, project.id]),
          label: `${project.name} · ${state.source.label}`,
        })) ?? [],
    ) ?? []
  const activeImage = previewIndex === null ? undefined : items[previewIndex]
  return (
    <div className="content-frame flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex flex-wrap items-center justify-between gap-4 px-6 pb-5 pt-8 sm:px-9">
        <h1 className="text-2xl font-semibold tracking-tight">图像</h1>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="搜索图像"
            placeholder="搜索名称或提示词"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="rounded-full pl-9"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 px-6 pb-5 sm:px-9">
        <Select
          value={hostFilter}
          onValueChange={(value) => {
            setHostFilter(value)
            setProjectFilter('all')
          }}
        >
          <SelectTrigger aria-label="筛选 Host" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部 Host</SelectItem>
            {sources.map((source) => (
              <SelectItem key={source.id} value={source.id}>
                {source.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger aria-label="筛选项目" className="w-52">
            <SelectValue placeholder="全部项目" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部项目</SelectItem>
            <SelectItem value="standalone">独立聊天</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.value} value={project.value}>
                {project.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" aria-label="刷新图像" disabled={loading} onClick={refresh}>
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
        {busy && (
          <span role="status" className="text-xs text-muted-foreground">
            正在处理图像…
          </span>
        )}
      </div>
      <div className="space-y-1 px-6 text-xs text-muted-foreground sm:px-9" role="status">
        {feed?.sources.map((state) => {
          const scan = state.page?.scan
          const notice =
            state.error ||
            scan?.error ||
            (scan?.running
              ? `正在补录历史图像 ${scan.completed}/${scan.total}`
              : scan?.skipped
                ? `${scan.skipped} 项历史结果无法收录`
                : '')
          return notice ? (
            <p key={state.source.id} className="pb-2">
              {state.source.label}：{notice}
            </p>
          ) : null
        })}
        {error && !dialogOpen && (
          <p role="alert" className="pb-2 text-destructive">
            {error}
          </p>
        )}
      </div>
      <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 sm:px-9">
        <div ref={wall} className="relative w-full" style={{ height: items.length ? layout.height : undefined }}>
          {items.map((item, index) => {
            const source = sources.find((source) => source.id === item.serviceId)
            return source && width > 0 ? (
              <div key={galleryKey(item)} className="absolute" style={layout.positions[index]}>
                <ImageTile
                  item={item}
                  source={source}
                  loader={loader}
                  root={scroll.current}
                  onOpen={(button) => {
                    trigger.current = button
                    void preview(index)
                  }}
                  onAction={(kind) => void action(item, kind)}
                />
              </div>
            ) : null
          })}
          {!items.length && (
            <div className="flex min-h-80 flex-col items-center justify-center gap-3 text-muted-foreground">
              <Images className="size-10 opacity-50" />
              <p className="text-sm">
                {loading ? '正在读取图像…' : query || projectFilter !== 'all' ? '没有找到匹配的图像' : '还没有图像'}
              </p>
              {!loading && !query && projectFilter === 'all' && (
                <p className="text-xs">在聊天中生成的图片会自动保存在这里。</p>
              )}
            </div>
          )}
        </div>
        {feed?.hasMore && (
          <div className="flex justify-center pt-5">
            <Button variant="outline" disabled={more || loading} onClick={() => void loadMore()}>
              {more ? '正在加载…' : '加载更多'}
            </Button>
          </div>
        )}
      </div>
      <ImageViewer
        images={items.map((item) => ({
          id: galleryKey(item),
          type: 'image' as const,
          mimeType: 'image/png',
          data: previewUrls[galleryKey(item)] ?? '',
        }))}
        activeIndex={previewIndex}
        onActiveIndexChange={(index) => void preview(index)}
        triggerRef={trigger}
        actions={
          activeImage && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="max-w-80 truncate text-sm">{activeImage.name}</span>
              <Button variant="ghost" size="sm" onClick={() => void action(activeImage, 'info')}>
                信息
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={Boolean(busy)}
                onClick={() => void action(activeImage, 'source')}
              >
                来源会话
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={Boolean(busy)}
                onClick={() => void action(activeImage, 'download')}
              >
                <Download className="size-4" />
                下载
              </Button>
              {error && (
                <span role="alert" className="text-xs text-destructive">
                  {error}
                </span>
              )}
            </div>
          )
        }
      />
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open && !busy) setDialogOpen(false)
        }}
      >
        <DialogContent className="max-h-[80dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {dialog?.action === 'rename' ? '重命名图像' : dialog?.action === 'remove' ? '从图像中移除' : '图像信息'}
            </DialogTitle>
            <DialogDescription>
              {dialog?.action === 'remove'
                ? '移除后不再显示在图像库中，聊天记录和原文件仍会保留。'
                : dialog?.action === 'rename'
                  ? '只修改图像库中的名称，不更改原文件。'
                  : dialog?.item.name}
            </DialogDescription>
          </DialogHeader>
          {dialog?.action === 'rename' && (
            <Input
              aria-label="图像名称"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !busy) void saveDialog()
              }}
            />
          )}
          {dialog?.action === 'info' && (
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-muted-foreground">提示词</dt>
                <dd className="mt-1 whitespace-pre-wrap break-words">{dialog.item.prompt || '历史记录未保存提示词'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">来源</dt>
                <dd>
                  {dialog.item.projectName || '独立聊天'} · {dialog.item.hostLabel}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">生成时间</dt>
                <dd>{new Date(dialog.item.createdAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">模型与尺寸</dt>
                <dd>
                  {dialog.item.model} · {dialog.item.width} × {dialog.item.height} ·{' '}
                  {dialog.item.operation === 'edit' ? '编辑' : '生成'}
                </dd>
              </div>
            </dl>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {dialog?.action !== 'info' && (
            <DialogFooter>
              <Button variant="outline" disabled={Boolean(busy)} onClick={() => setDialogOpen(false)}>
                取消
              </Button>
              <Button
                variant={dialog?.action === 'remove' ? 'destructive' : 'default'}
                disabled={Boolean(busy) || (dialog?.action === 'rename' && !name.trim())}
                onClick={() => void saveDialog()}
              >
                {busy ? '正在保存…' : dialog?.action === 'remove' ? '移除' : '保存'}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
