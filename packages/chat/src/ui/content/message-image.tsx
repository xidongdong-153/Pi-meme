import * as React from 'react'
import type { FilePreview } from '@pi-meme/contracts/app-host'
import { cn } from '@pi-meme/ui/lib/utils'
import { ImageViewer } from './image-viewer'

export type MessageImageLoader = (relativePath: string) => Promise<FilePreview>
export const MessageImageLoaderContext = React.createContext<MessageImageLoader | undefined>(undefined)

export function isImageLink(href: string) {
  return /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(href.split(/[?#]/, 1)[0])
}

function imageLabel(src: string, alt?: string) {
  if (alt?.trim()) return alt.trim()
  const filename = src.split(/[?#]/, 1)[0].split('/').pop()
  if (!filename || src.startsWith('data:')) return '图片'
  try {
    return decodeURIComponent(filename)
  } catch {
    return filename
  }
}

export function MessageImage({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  const loadImage = React.useContext(MessageImageLoaderContext)
  const remote = /^(?:https?:)?\/\//i.test(src)
  const [result, setResult] = React.useState<{
    src: string
    loader?: MessageImageLoader
    url?: string
    error?: string
  }>()
  const [retry, setRetry] = React.useState(0)
  const current = result?.src === src && result.loader === loadImage ? result : undefined

  React.useEffect(() => {
    if (remote) return
    let active = true
    const load = async () => {
      try {
        if (!loadImage) {
          if (active) setResult({ src, loader: loadImage, error: '当前内容没有可用的会话文件读取器。' })
          return
        }
        const relativePath = decodeURIComponent(src.split(/[?#]/, 1)[0])
        const preview = await loadImage(relativePath)
        if (!active) return
        if (preview.kind === 'image') setResult({ src, loader: loadImage, url: preview.dataUrl })
        else
          setResult({
            src,
            loader: loadImage,
            error:
              preview.kind === 'unsupported' && preview.reason === 'too-large'
                ? '图片超过 8 MiB，无法预览。'
                : '该文件不是可预览的图片。',
          })
      } catch {
        if (active)
          setResult({ src, loader: loadImage, error: '图片不存在或无法读取，请确认路径相对于当前会话工作目录。' })
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [src, remote, loadImage, retry])

  const url = remote ? src : current?.url
  return (
    <ImageThumbnail
      key={url ?? src}
      src={url}
      label={imageLabel(src, alt)}
      filename={imageLabel(src)}
      error={current?.error}
      remote={remote}
      className={className}
      onRetry={() => {
        setResult(undefined)
        setRetry((value) => value + 1)
      }}
    />
  )
}

export function ImageThumbnail({
  src,
  label,
  filename,
  error,
  remote,
  className,
  onRetry,
}: {
  src?: string
  label: string
  filename: string
  error?: string
  remote: boolean
  className?: string
  onRetry?: () => void
}) {
  const [failed, setFailed] = React.useState(false)
  const [loaded, setLoaded] = React.useState(false)
  const [previewSource, setPreviewSource] = React.useState<string | null>(null)
  const [source, setSource] = React.useState(src)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  if (source !== src) {
    setSource(src)
    setFailed(false)
    setLoaded(false)
    setPreviewSource(null)
  }
  const failure = error || (failed ? '图片加载失败' : '')
  const originalLink = src ? (
    <a
      href={src}
      target={remote ? '_blank' : undefined}
      rel={remote ? 'noopener noreferrer' : undefined}
      download={remote ? undefined : filename}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {remote ? '打开原图' : '下载原图'}
    </a>
  ) : null

  return (
    <span className={cn('my-2 mr-2 inline-flex size-24 max-w-full align-top', className)}>
      {failure ? (
        <span role="status" aria-label={failure} className="size-full">
          <button
            type="button"
            title={failure}
            onClick={() => {
              setFailed(false)
              onRetry?.()
            }}
            className="flex size-full cursor-pointer items-center justify-center rounded-xl bg-secondary/30 px-2 text-center text-xs text-muted-foreground hover:bg-secondary/50"
          >
            <span>
              预览失败
              <br />
              点击重试
            </span>
          </button>
        </span>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          aria-label={`预览图片：${label}`}
          disabled={!src}
          aria-busy={!loaded}
          onClick={() => src && setPreviewSource(src.startsWith('data:') ? src : new URL(src, document.baseURI).href)}
          className="block size-full cursor-zoom-in overflow-hidden rounded-xl bg-secondary/30 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
        >
          {src && (
            <img
              src={src}
              alt={label}
              loading="lazy"
              decoding="async"
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
              className={cn('size-full object-cover', !loaded && 'opacity-0')}
            />
          )}
        </button>
      )}
      <ImageViewer
        images={previewSource ? [{ type: 'image', mimeType: '', data: previewSource }] : []}
        activeIndex={previewSource ? 0 : null}
        onActiveIndexChange={(index) => index === null && setPreviewSource(null)}
        triggerRef={triggerRef}
        actions={originalLink}
      />
    </span>
  )
}
