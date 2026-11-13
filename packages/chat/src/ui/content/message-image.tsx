import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import * as React from 'react'
import { ChevronDown, Images } from 'lucide-react'
import { maxImagePreviewBytes, type FilePreview } from '@pi-meme/contracts/app-host'
import { cn } from '@pi-meme/ui/lib/utils'
import { ImageViewer } from './image-viewer'

export type MessageImageLoader = (relativePath: string) => Promise<FilePreview>
export const MessageImageLoaderContext = React.createContext<MessageImageLoader | undefined>(undefined)

export function ImageDisclosure({
  label,
  children,
  inline = false,
}: {
  label: string
  children: React.ReactNode
  inline?: boolean
}) {
  const [open, setOpen] = React.useState(true)
  const detailsId = React.useId()
  const Container = inline ? 'span' : 'div'
  return (
    <Container className={inline ? 'my-2 mr-2 inline-flex max-w-full flex-col align-top' : 'min-w-0'}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((value) => !value)}
        className="conversation-activity-toggle flex min-h-6 w-fit max-w-full items-start gap-2 rounded-sm pr-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
      >
        <span aria-hidden="true" className="mt-[0.16em] inline-flex size-[1.4em] shrink-0 items-center justify-center">
          <Images className="size-[1.15em]" />
        </span>
        <span className="min-w-0 truncate">{label}</span>
        <span
          aria-hidden="true"
          className={cn(
            'mt-[0.16em] inline-flex size-[1.4em] shrink-0 items-center justify-center transition-transform duration-200 motion-reduce:transition-none',
            !open && '-rotate-90',
          )}
        >
          <ChevronDown className="size-3.5" />
        </span>
      </button>
      <Container id={detailsId} hidden={!open}>
        {children}
      </Container>
    </Container>
  )
}

function classifyImageError(cause: unknown, relativePath: string): { error: string; reason: string } {
  const rawMessage = cause instanceof Error ? cause.message : ''
  const isAbsolute = /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(relativePath)
  if (rawMessage.includes('越出工作目录和附件目录')) {
    return { error: '图片路径不在当前会话工作目录或附件目录内。', reason: '图片路径超出范围' }
  }
  if (rawMessage.includes('越出附件目录')) {
    return { error: '图片路径越出附件目录。', reason: '图片不在附件目录' }
  }
  if (rawMessage.includes('越出工作目录') || rawMessage.includes('必须是工作目录内的相对路径')) {
    return { error: '图片路径越出当前会话工作目录。', reason: '路径越出工作目录' }
  }
  if (rawMessage.includes('只支持图片') || rawMessage.includes('只能预览普通文件')) {
    return { error: '该文件不是可预览的图片。', reason: '非可预览图片' }
  }
  if (rawMessage.includes('目标 Host 无效')) {
    return { error: '无法连接图片所在设备。', reason: '设备不可用' }
  }
  if (rawMessage.includes('EACCES') || rawMessage.includes('EPERM')) {
    return { error: '没有读取该图片的系统权限。', reason: '无读取权限' }
  }
  if (isAbsolute) {
    return { error: '图片不存在或无法读取。', reason: '图片无法读取' }
  }
  return { error: '图片不存在或无法读取，请确认路径相对于当前会话工作目录。', reason: '图片无法读取' }
}

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
    reason?: string
  }>()
  const [retry, setRetry] = React.useState(0)
  const current = result?.src === src && result.loader === loadImage ? result : undefined

  React.useEffect(() => {
    if (remote) return
    let active = true
    const rawPath = src.split(/[?#]/, 1)[0]
    let relativePath = rawPath
    try {
      relativePath = decodeURIComponent(rawPath)
    } catch {
      // 保留原始路径，避免非法编码二次抛错
    }
    const load = async () => {
      try {
        if (!loadImage) {
          if (active)
            setResult({
              src,
              loader: loadImage,
              error: '当前内容没有可用的会话文件读取器。',
              reason: '无文件读取器',
            })
          return
        }
        const preview = await loadImage(relativePath)
        if (!active) return
        if (preview.kind === 'image') setResult({ src, loader: loadImage, url: preview.dataUrl })
        else {
          const maxMiB = Math.round(maxImagePreviewBytes / (1024 * 1024))
          const isTooLarge = preview.kind === 'unsupported' && preview.reason === 'too-large'
          setResult({
            src,
            loader: loadImage,
            error: isTooLarge ? `图片超过 ${maxMiB} MiB，无法预览。` : '该文件不是可预览的图片。',
            reason: isTooLarge ? `图片超过 ${maxMiB} MiB` : '非可预览图片',
          })
        }
      } catch (cause) {
        if (active) {
          const { error, reason } = classifyImageError(cause, relativePath)
          setResult({ src, loader: loadImage, error, reason })
        }
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [src, remote, loadImage, retry])

  const url = remote ? src : current?.url
  return (
    <ImageDisclosure label="查看图像" inline>
      <ImageThumbnail
        key={url ?? src}
        src={url}
        label={imageLabel(src, alt)}
        filename={imageLabel(src)}
        error={current?.error}
        reason={current?.reason}
        remote={remote}
        className={className}
        onRetry={() => {
          setResult(undefined)
          setRetry((value) => value + 1)
        }}
      />
    </ImageDisclosure>
  )
}

export function ImageThumbnail({
  src,
  label,
  filename,
  error,
  reason,
  remote,
  className,
  onRetry,
}: {
  src?: string
  label: string
  filename: string
  error?: string
  reason?: string
  remote: boolean
  className?: string
  onRetry?: () => void
}) {
  const [failed, setFailed] = React.useState(false)
  const [loaded, setLoaded] = React.useState(false)
  const [attempt, setAttempt] = React.useState(0)
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
  const displayReason = reason
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
          <TooltipHint content={failure}>
            <button
              type="button"
              aria-label="预览失败点击重试"
              onClick={() => {
                setFailed(false)
                setLoaded(false)
                setAttempt((value) => value + 1)
                onRetry?.()
              }}
              className="flex size-full cursor-pointer flex-col items-center justify-center rounded-xl bg-secondary/30 px-1 py-1.5 text-center text-xs text-muted-foreground hover:bg-secondary/50"
            >
              <span className="flex flex-col items-center justify-center leading-tight">
                <span className="font-medium text-foreground/80">预览失败</span>
                {displayReason ? (
                  <span className="my-0.5 line-clamp-2 text-xs text-muted-foreground">{displayReason}</span>
                ) : null}
                <span className="text-xs text-muted-foreground/70">点击重试</span>
              </span>
            </button>
          </TooltipHint>
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
              key={attempt}
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
