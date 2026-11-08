import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Download, ExternalLink, Images, Info, MoreHorizontal, Pencil, Search, Trash2 } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { OverflowTooltip, TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'
import { imageMasonry, type GalleryImageLoader, type ImageLibrarySource } from '../images/image-library-data'
import type { ImageMaterial, MaterialAction, MaterialView } from './material-types'
import { materialKey } from './material-types'

export function MaterialActionsMenu({
  material,
  onAction,
  disabled = false,
  className,
}: {
  material: ImageMaterial
  onAction: (action: MaterialAction) => void
  disabled?: boolean
  className?: string
}) {
  const image = material.image
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`${material.name}的操作`}
          className={cn('materials-more rounded-full', className)}
          disabled={disabled}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" className="w-44 rounded-xl">
        <DropdownMenuItem onSelect={() => onAction('info')}>
          <Info className="size-4" />
          查看信息
        </DropdownMenuItem>
        {image.origin !== 'uploaded' && image.sourceStatus !== 'detached' && (
          <DropdownMenuItem onSelect={() => onAction('source')}>
            <ExternalLink className="size-4" />
            打开来源会话
          </DropdownMenuItem>
        )}
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
          从资料空间移除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function MaterialImage({
  material,
  source,
  loader,
  root,
  compact = false,
  onOpen,
}: {
  material: ImageMaterial
  source?: ImageLibrarySource
  loader: GalleryImageLoader
  root: HTMLDivElement | null
  compact?: boolean
  onOpen: (button: HTMLButtonElement) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [near, setNear] = useState(false)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const image = material.image
  useEffect(() => {
    if (!ref.current) return
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root, rootMargin: '400px' })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [root])
  useEffect(() => {
    let cancelled = false
    if (!near || !source) {
      setUrl('')
      return
    }
    setError('')
    void loader
      .load(image, source)
      .then((value) => {
        if (!cancelled) setUrl(value)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '图片加载失败，点击重试')
      })
    return () => {
      cancelled = true
    }
  }, [near, image.id, image.hostId, source?.host, source?.connected, loader, retry])
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`查看图像：${material.name}${error ? '，加载失败，点击重试' : ''}`}
      className={cn(
        'materials-image relative flex min-h-0 items-center justify-center overflow-hidden',
        compact && 'is-compact',
      )}
      onClick={(event) => {
        if (error) {
          loader.invalidate(image)
          setUrl('')
          setError('')
          setRetry((value) => value + 1)
        } else onOpen(event.currentTarget)
      }}
    >
      {url ? (
        <img
          src={url}
          alt={material.name}
          className="size-full object-contain"
          loading="lazy"
          onError={() => setError('图片无法显示，点击重试')}
        />
      ) : (
        <span className="sr-only">正在加载图片</span>
      )}
      {error && (
        <span className="absolute inset-0 flex items-center justify-center bg-background/90 p-3 text-xs text-muted-foreground">
          {compact ? '重试' : error}
        </span>
      )}
    </button>
  )
}

function relativeTime(value: string) {
  const milliseconds = Date.now() - Date.parse(value)
  if (!Number.isFinite(milliseconds)) return '—'
  if (milliseconds < 60_000) return '刚刚'
  if (milliseconds < 3_600_000) return `${Math.floor(milliseconds / 60_000)} 分钟前`
  if (milliseconds < 86_400_000) return `${Math.floor(milliseconds / 3_600_000)} 小时前`
  const days = Math.floor(milliseconds / 86_400_000)
  if (days < 7) return `${days} 天前`
  if (days < 30) return `${Math.floor(days / 7)} 周前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

export function MaterialsCollection({
  materials,
  sources,
  view,
  loader,
  scrollRef,
  visible,
  loading,
  hasMore,
  more,
  emptyText,
  busyKey,
  onOpen,
  onAction,
  onLoadMore,
}: {
  materials: ImageMaterial[]
  sources: ImageLibrarySource[]
  view: MaterialView
  loader: GalleryImageLoader
  scrollRef: RefObject<HTMLDivElement | null>
  visible: boolean
  loading: boolean
  hasMore: boolean
  more: boolean
  emptyText: string
  busyKey: string
  onOpen: (material: ImageMaterial, button: HTMLButtonElement) => void
  onAction: (material: ImageMaterial, action: MaterialAction) => void
  onLoadMore: () => void
}) {
  const wall = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!visible || !wall.current) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(entry.contentRect.width)
    })
    observer.observe(wall.current)
    return () => observer.disconnect()
  }, [visible, view])
  const positions = useMemo(
    () =>
      imageMasonry(
        materials.map((item) => item.image),
        width,
      ),
    [materials, width],
  )
  const sourceMap = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources])
  return (
    <div ref={scrollRef} className="materials-scroll min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
      <div ref={wall} className="min-h-full">
        {view === 'list' && materials.length > 0 ? (
          <table className="materials-table w-full table-fixed border-collapse text-left">
            <thead>
              <tr>
                <th scope="col" className="font-normal">
                  名称
                </th>
                <th scope="col" className="w-[24%] font-normal">
                  来源
                </th>
                <th scope="col" className="w-[20%] font-normal">
                  创建时间
                </th>
                <th scope="col" className="w-10">
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {materials.map((material) => (
                <tr key={materialKey(material.ref)} className="group">
                  <td>
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="size-8 shrink-0 overflow-hidden rounded-lg border border-border/50">
                        <MaterialImage
                          material={material}
                          source={sourceMap.get(material.serviceId)}
                          loader={loader}
                          root={scrollRef.current}
                          compact
                          onOpen={(button) => onOpen(material, button)}
                        />
                      </div>
                      <button
                        type="button"
                        className="min-w-0 flex-1 py-3 text-left"
                        onClick={(event) => onOpen(material, event.currentTarget)}
                      >
                        <OverflowTooltip content={material.name}>
                          <span className="block truncate">{material.name}</span>
                        </OverflowTooltip>
                      </button>
                    </div>
                  </td>
                  <td className="text-muted-foreground">
                    <OverflowTooltip content={material.sourceLabel}>
                      <span className="block truncate">{material.sourceLabel}</span>
                    </OverflowTooltip>
                  </td>
                  <td className="text-muted-foreground">
                    <TooltipHint content={new Date(material.createdAt).toLocaleString()}>
                      <time dateTime={material.createdAt}>{relativeTime(material.createdAt)}</time>
                    </TooltipHint>
                  </td>
                  <td>
                    <MaterialActionsMenu
                      material={material}
                      onAction={(action) => onAction(material, action)}
                      disabled={busyKey === materialKey(material.ref)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div
            className={cn(view === 'grid' ? 'materials-grid' : 'relative')}
            style={view === 'masonry' && materials.length ? { height: positions.height } : undefined}
          >
            {materials.map((material, index) => (
              <article
                key={materialKey(material.ref)}
                className={cn('materials-card group', view === 'masonry' && 'absolute')}
                style={view === 'masonry' ? positions.positions[index] : undefined}
              >
                {view === 'grid' && (
                  <div className="materials-card-title flex min-w-0 items-center gap-2 px-3">
                    <Images className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{material.name}</span>
                  </div>
                )}
                <MaterialImage
                  material={material}
                  source={sourceMap.get(material.serviceId)}
                  loader={loader}
                  root={scrollRef.current}
                  onOpen={(button) => onOpen(material, button)}
                />
                {view === 'masonry' && (
                  <span className="materials-card-caption pointer-events-none absolute inset-x-0 bottom-0 truncate px-3 py-2 text-xs">
                    {material.name}
                  </span>
                )}
                <MaterialActionsMenu
                  material={material}
                  className="materials-card-menu absolute right-2 top-2"
                  disabled={busyKey === materialKey(material.ref)}
                  onAction={(action) => onAction(material, action)}
                />
              </article>
            ))}
          </div>
        )}
        {materials.length === 0 && (
          <div className="materials-empty flex min-h-80 flex-col items-center justify-center gap-3 text-muted-foreground">
            {loading ? (
              <span role="status" className="ui-loading-delayed text-sm">
                正在读取资料…
              </span>
            ) : (
              <>
                <Search className="size-5" />
                <p className="text-sm">{emptyText}</p>
              </>
            )}
          </div>
        )}
        {hasMore && (
          <div className="flex justify-center py-6">
            <Button variant="outline" disabled={more || loading} onClick={onLoadMore}>
              {more ? '正在加载…' : '加载更多'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
