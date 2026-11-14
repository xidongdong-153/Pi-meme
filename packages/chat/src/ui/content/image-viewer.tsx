import * as React from 'react'
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react'
import type { PiImage } from '@pi-meme/contracts/pi'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import { cn } from '@pi-meme/ui/lib/utils'

type PreviewImage = PiImage & { id?: string }

export function imageSource(image: PiImage) {
  if (image.data.startsWith('data:') || image.data.startsWith('http') || image.data.startsWith('blob:'))
    return image.data
  return `data:${image.mimeType || 'image/png'};base64,${image.data}`
}

interface ImageViewerProps {
  images: PreviewImage[]
  activeIndex: number | null
  onActiveIndexChange: (index: number | null) => void
  triggerRef: React.RefObject<HTMLButtonElement | null>
  variant?: 'image' | 'diagram'
  actions?: React.ReactNode
}

export function ImageViewer({
  images,
  activeIndex,
  onActiveIndexChange,
  triggerRef,
  variant = 'image',
  actions,
}: ImageViewerProps) {
  const index = activeIndex === null ? null : Math.min(activeIndex, images.length - 1)
  const image = index === null ? null : images[index]
  const navigate = (offset: number) => {
    if (index === null) return
    onActiveIndexChange(Math.max(0, Math.min(images.length - 1, index + offset)))
  }

  return (
    <Dialog open={Boolean(image)} onOpenChange={(open) => !open && onActiveIndexChange(null)}>
      <DialogContent
        className={cn(
          'h-dvh max-h-dvh w-screen max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-2 overflow-hidden rounded-none border-0 bg-transparent p-2 shadow-none',
          '[&>button:last-child]:right-2 [&>button:last-child]:top-2 [&>button:last-child]:inline-flex [&>button:last-child]:size-8 [&>button:last-child]:items-center [&>button:last-child]:justify-center [&>button:last-child]:rounded-full [&>button:last-child]:bg-secondary/80 [&>button:last-child]:opacity-100 [&>button:last-child]:hover:bg-secondary',
        )}
        onPointerDown={(event) => {
          if (event.isPrimary && event.button === 0 && event.target === event.currentTarget) onActiveIndexChange(null)
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          triggerRef.current?.focus()
        }}
        onKeyDown={(event) => {
          if (
            (event.target instanceof Element && event.target.closest('[role="combobox"], [role="listbox"]')) ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            navigate(event.key === 'ArrowLeft' ? -1 : 1)
          }
        }}
      >
        <DialogTitle className="sr-only">{variant === 'diagram' ? '图表预览' : '图片预览'}</DialogTitle>
        <DialogDescription className="sr-only">
          {variant === 'diagram'
            ? '拖拽查看图表，滚轮缩放，点击周围空白或按 Esc 关闭。'
            : '拖拽查看图片，滚轮缩放，左右方向键切换图片，点击周围空白或按 Esc 关闭。'}
        </DialogDescription>
        {image && index !== null && (
          <ImagePreviewStage
            key={`${index}:${image.id ?? image.mimeType}`}
            image={image}
            imageId={image.id}
            autoFocus
            index={index}
            count={images.length}
            onNavigate={navigate}
            variant={variant}
            actions={actions}
            viewportClassName={cn(
              'h-[calc(88dvh-5rem)] max-h-full w-[calc(100vw-4rem)] max-w-[calc(100rem-2rem)] place-self-center sm:w-[calc(90vw-2rem)]',
              variant !== 'diagram' && images.length > 1 && 'h-[calc(88dvh-7rem)]',
            )}
            onDismiss={() => onActiveIndexChange(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

export function nextImageZoom(current: number, factor: number) {
  const next = Math.max(0.01, Math.min(500, Math.round(current * factor * 100) / 100))
  return factor < 1 ? Math.min(current, next) : Math.max(current, next)
}

const zoomOptions = [25, 50, 75, 100, 125, 150, 200, 300, 400, 500]
const controlClass =
  'flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary/80 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30 disabled:cursor-default cursor-pointer'

/** 非模态图片舞台；聊天预览仍由 ImageViewer 的 Dialog 管理焦点。 */
export function ImagePreviewStage({
  image,
  imageId,
  index,
  count,
  onNavigate,
  variant = 'image',
  actions,
  autoFocus = false,
  onError,
  onDismiss,
  viewportClassName,
}: {
  image: PiImage
  imageId?: string
  index: number
  count: number
  onNavigate: (offset: number) => void
  variant?: 'image' | 'diagram'
  actions?: React.ReactNode
  autoFocus?: boolean
  onError?: (message: string) => void
  onDismiss?: () => void
  viewportClassName?: string
}) {
  const isDiagram = variant === 'diagram'
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const imageRef = React.useRef<HTMLImageElement>(null)
  const suppressClickRef = React.useRef(false)
  const zoomAnchorRef = React.useRef<{ x: number; y: number } | null>(null)
  const [zoom, setZoom] = React.useState<number | null>(null)
  const [naturalSize, setNaturalSize] = React.useState<{ width: number; height: number } | null>(null)
  const [error, setError] = React.useState('')
  const [retry, setRetry] = React.useState(0)
  const [source, setSource] = React.useState({ data: image.data, mimeType: image.mimeType, imageId })

  if (source.data !== image.data || source.mimeType !== image.mimeType || source.imageId !== imageId) {
    setSource({ data: image.data, mimeType: image.mimeType, imageId })
    setZoom(null)
    setNaturalSize(null)
    setError('')
    setRetry((value) => value + 1)
  }

  const updateZoom = React.useCallback((value: React.SetStateAction<number | null>) => {
    const viewport = viewportRef.current
    const bounds = imageRef.current?.getBoundingClientRect()
    if (viewport && bounds?.width && bounds.height) {
      const frame = viewport.getBoundingClientRect()
      zoomAnchorRef.current = {
        x: Math.max(0, Math.min(1, (frame.left + viewport.clientWidth / 2 - bounds.left) / bounds.width)),
        y: Math.max(0, Math.min(1, (frame.top + viewport.clientHeight / 2 - bounds.top) / bounds.height)),
      }
    }
    setZoom(value)
  }, [])

  const changeZoom = React.useCallback(
    (factor: number) => {
      updateZoom((current) => {
        const element = imageRef.current
        const fitted = element?.naturalWidth ? (element.clientWidth / element.naturalWidth) * 100 : 100
        return nextImageZoom(current ?? fitted, factor)
      })
    },
    [updateZoom],
  )

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    const bounds = imageRef.current?.getBoundingClientRect()
    const anchor = zoomAnchorRef.current
    if (!viewport) return
    if (zoom === null) viewport.scrollTo(0, 0)
    else if (bounds && anchor) {
      const frame = viewport.getBoundingClientRect()
      viewport.scrollLeft += bounds.left + bounds.width * anchor.x - frame.left - viewport.clientWidth / 2
      viewport.scrollTop += bounds.top + bounds.height * anchor.y - frame.top - viewport.clientHeight / 2
    }
    zoomAnchorRef.current = null
  }, [zoom, naturalSize])

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    if (autoFocus) viewport.focus({ preventScroll: true })
    let drag: {
      pointerId: number
      x: number
      y: number
      left: number
      top: number
      moved: boolean
      fromBackground: boolean
    } | null = null
    const isBackground = (target: EventTarget | null) => target === viewport || target === viewport.firstElementChild
    const endDrag = () => {
      const pointerId = drag?.pointerId
      drag = null
      delete viewport.dataset.dragging
      if (pointerId !== undefined && viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId)
    }
    const cancelDrag = () => {
      if (drag) suppressClickRef.current = true
      endDrag()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary || drag) return
      suppressClickRef.current = false
      if (event.target !== imageRef.current && !isBackground(event.target)) return
      drag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: viewport.scrollLeft,
        top: viewport.scrollTop,
        moved: false,
        fromBackground: isBackground(event.target),
      }
      viewport.setPointerCapture(event.pointerId)
      viewport.focus({ preventScroll: true })
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      const x = event.clientX - drag.x
      const y = event.clientY - drag.y
      if (!drag.moved && Math.hypot(x, y) < 4) return
      drag.moved = true
      viewport.dataset.dragging = 'true'
      viewport.scrollLeft = drag.left - x
      viewport.scrollTop = drag.top - y
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      suppressClickRef.current =
        drag.moved || !drag.fromBackground || !isBackground(document.elementFromPoint(event.clientX, event.clientY))
      endDrag()
    }
    const onPointerCancel = (event: PointerEvent) => {
      if (drag?.pointerId === event.pointerId) cancelDrag()
    }
    const onLostPointerCapture = onPointerCancel
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY) return
      event.preventDefault()
      changeZoom(event.deltaY < 0 ? 1.1 : 1 / 1.1)
    }
    viewport.addEventListener('pointerdown', onPointerDown)
    viewport.addEventListener('pointermove', onPointerMove)
    viewport.addEventListener('pointerup', onPointerUp)
    viewport.addEventListener('pointercancel', onPointerCancel)
    viewport.addEventListener('lostpointercapture', onLostPointerCapture)
    viewport.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('blur', cancelDrag)
    return () => {
      viewport.removeEventListener('pointerdown', onPointerDown)
      viewport.removeEventListener('pointermove', onPointerMove)
      viewport.removeEventListener('pointerup', onPointerUp)
      viewport.removeEventListener('pointercancel', onPointerCancel)
      viewport.removeEventListener('lostpointercapture', onLostPointerCapture)
      viewport.removeEventListener('wheel', onWheel)
      window.removeEventListener('blur', cancelDrag)
      cancelDrag()
    }
  }, [changeZoom, autoFocus, source, retry])

  const dismissOnBackgroundClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onDismiss?.()
  }

  const zoomControls = (
    <>
      <button
        type="button"
        aria-label={isDiagram ? '缩小图表' : '缩小图片'}
        disabled={zoom !== null && zoom <= 0.01}
        onClick={() => changeZoom(1 / 1.25)}
        className={cn(controlClass, 'hidden sm:flex')}
      >
        <ZoomOut className="size-4" />
      </button>
      <Select
        value={zoom === null ? 'fit' : String(zoom)}
        onValueChange={(value) => updateZoom(value === 'fit' ? null : Number(value))}
      >
        <SelectTrigger
          aria-label={isDiagram ? '图表缩放比例' : '图片缩放比例'}
          className="h-8 w-28 shrink-0 gap-1 rounded-full border-0 bg-secondary/80 shadow-none enabled:hover:bg-secondary"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent side="bottom" align="end">
          <SelectItem value="fit">适应窗口</SelectItem>
          {zoom !== null && !zoomOptions.includes(zoom) && <SelectItem value={String(zoom)}>{zoom}%</SelectItem>}
          {zoomOptions.map((value) => (
            <SelectItem key={value} value={String(value)}>
              {value}%
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <button
        type="button"
        aria-label={isDiagram ? '放大图表' : '放大图片'}
        disabled={zoom === 500}
        onClick={() => changeZoom(1.25)}
        className={cn(controlClass, 'hidden sm:flex')}
      >
        <ZoomIn className="size-4" />
      </button>
    </>
  )

  return (
    <>
      <div className="flex min-h-8 min-w-0 items-center justify-end gap-2 pr-10" onClick={dismissOnBackgroundClick}>
        {zoomControls}
        {actions}
      </div>
      <div
        ref={viewportRef}
        tabIndex={0}
        className={cn(
          'h-full min-h-0 min-w-0 touch-none overflow-auto overscroll-contain rounded-md bg-transparent [overflow-anchor:none] focus-visible:outline-none [&::-webkit-scrollbar]:hidden',
          !error && 'cursor-grab data-[dragging=true]:cursor-grabbing',
          viewportClassName,
        )}
        aria-label={isDiagram ? '图表预览区域' : '图片预览区域'}
        style={{ scrollbarWidth: 'none' }}
        onClickCapture={(event) => {
          if (event.detail === 0 || !suppressClickRef.current) return
          suppressClickRef.current = false
          event.preventDefault()
          event.stopPropagation()
        }}
        onClick={dismissOnBackgroundClick}
      >
        <div
          onClick={dismissOnBackgroundClick}
          className={
            zoom === null
              ? 'flex h-full w-full items-center justify-center'
              : 'flex min-h-full min-w-full w-fit items-center justify-center'
          }
        >
          {error ? (
            <div className="flex flex-col items-center gap-3 p-6 text-center">
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  setError('')
                  setZoom(null)
                  setNaturalSize(null)
                  setRetry((value) => value + 1)
                }}
              >
                重试
              </Button>
            </div>
          ) : (
            <img
              key={retry}
              ref={imageRef}
              src={imageSource(image)}
              alt={isDiagram ? 'Mermaid 图表大图预览' : `图片大图预览，第 ${index + 1} 张`}
              draggable={false}
              onLoad={(event) =>
                setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
              }
              onError={() => {
                const message = isDiagram ? '图表无法显示，请重试' : '图片无法显示，文件可能已损坏，请重试'
                setZoom(null)
                setNaturalSize(null)
                setError(message)
                onError?.(message)
              }}
              className={
                zoom === null ? 'max-h-full max-w-full object-contain select-none' : 'max-w-none shrink-0 select-none'
              }
              style={
                zoom !== null && naturalSize
                  ? { width: (naturalSize.width * zoom) / 100, height: (naturalSize.height * zoom) / 100 }
                  : undefined
              }
            />
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2" onClick={dismissOnBackgroundClick}>
        {!isDiagram && count > 1 && (
          <>
            <button
              type="button"
              aria-label="上一张图片"
              disabled={index === 0}
              onClick={() => onNavigate(-1)}
              className={controlClass}
            >
              <ChevronLeft className="size-4" />
            </button>
            <span
              aria-live="polite"
              className="min-w-12 rounded-full bg-secondary/80 px-3 py-1.5 text-center text-sm text-foreground"
            >
              {index + 1} / {count}
            </span>
            <button
              type="button"
              aria-label="下一张图片"
              disabled={index === count - 1}
              onClick={() => onNavigate(1)}
              className={controlClass}
            >
              <ChevronRight className="size-4" />
            </button>
          </>
        )}
      </div>
    </>
  )
}
