import * as React from 'react'
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react'
import type { PiImage } from '@pi-meme/contracts/pi'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { BrandMark } from '@pi-meme/ui/components/brand-mark'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'

type PreviewImage = PiImage & { id?: string }

export function imageSource(image: PiImage) {
  if (image.data.startsWith('data:') || image.data.startsWith('http')) return image.data
  return `data:${image.mimeType || 'image/png'};base64,${image.data}`
}

interface ImageViewerProps {
  images: PreviewImage[]
  activeIndex: number | null
  onActiveIndexChange: (index: number | null) => void
  triggerRef: React.RefObject<HTMLButtonElement | null>
}

export function ImageViewer({ images, activeIndex, onActiveIndexChange, triggerRef }: ImageViewerProps) {
  const index = activeIndex === null ? null : Math.min(activeIndex, images.length - 1)
  const image = index === null ? null : images[index]
  const navigate = (offset: number) => {
    if (index === null) return
    onActiveIndexChange(Math.max(0, Math.min(images.length - 1, index + offset)))
  }

  return (
    <Dialog open={Boolean(image)} onOpenChange={(open) => !open && onActiveIndexChange(null)}>
      <DialogContent
        className="w-[calc(100vw-2rem)] max-w-5xl gap-2 overflow-hidden border-border bg-card p-3"
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
        <DialogTitle className="sr-only">图片预览</DialogTitle>
        <DialogDescription className="sr-only">左右方向键切换图片，滚轮缩放，Esc 关闭预览。</DialogDescription>
        {image && index !== null && (
          <ImageViewerContent
            key={`${index}:${image.id ?? image.mimeType}`}
            image={image}
            index={index}
            count={images.length}
            onNavigate={navigate}
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
  'flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30 disabled:cursor-default cursor-pointer'

function ImageViewerContent({
  image,
  index,
  count,
  onNavigate,
}: {
  image: PreviewImage
  index: number
  count: number
  onNavigate: (offset: number) => void
}) {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const imageRef = React.useRef<HTMLImageElement>(null)
  const [zoom, setZoom] = React.useState<number | null>(null)
  const [naturalSize, setNaturalSize] = React.useState<{ width: number; height: number } | null>(null)
  const [source, setSource] = React.useState({ data: image.data, mimeType: image.mimeType })

  if (source.data !== image.data || source.mimeType !== image.mimeType) {
    setSource({ data: image.data, mimeType: image.mimeType })
    setZoom(null)
    setNaturalSize(null)
  }

  const changeZoom = React.useCallback((factor: number) => {
    setZoom((current) => {
      const element = imageRef.current
      const fitted = element?.naturalWidth ? (element.clientWidth / element.naturalWidth) * 100 : 100
      return nextImageZoom(current ?? fitted, factor)
    })
  }, [])

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.focus({ preventScroll: true })
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY) return
      event.preventDefault()
      changeZoom(event.deltaY < 0 ? 1.1 : 1 / 1.1)
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [changeZoom])

  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2 pr-8">
        <BrandMark size={24} />
        <span aria-live="polite" className="mr-auto text-sm text-muted-foreground">
          {index + 1} / {count}
        </span>
        <button
          type="button"
          aria-label="上一张图片"
          disabled={index === 0}
          onClick={() => onNavigate(-1)}
          className={controlClass}
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          type="button"
          aria-label="下一张图片"
          disabled={index === count - 1}
          onClick={() => onNavigate(1)}
          className={controlClass}
        >
          <ChevronRight className="size-4" />
        </button>
        <button
          type="button"
          aria-label="缩小图片"
          disabled={zoom !== null && zoom <= 0.01}
          onClick={() => changeZoom(1 / 1.25)}
          className={controlClass}
        >
          <ZoomOut className="size-4" />
        </button>
        <Select
          value={zoom === null ? 'fit' : String(zoom)}
          onValueChange={(value) => setZoom(value === 'fit' ? null : Number(value))}
        >
          <SelectTrigger aria-label="图片缩放比例" className="h-8 w-32 bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
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
          aria-label="放大图片"
          disabled={zoom === 500}
          onClick={() => changeZoom(1.25)}
          className={controlClass}
        >
          <ZoomIn className="size-4" />
        </button>
      </div>
      <div
        ref={viewportRef}
        tabIndex={0}
        className="h-[min(70vh,50rem)] min-h-0 overflow-auto rounded-md bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="图片预览区域"
      >
        <div
          className={
            zoom === null
              ? 'flex h-full w-full items-center justify-center'
              : 'flex min-h-full min-w-full w-fit items-center justify-center'
          }
        >
          <img
            ref={imageRef}
            src={imageSource(image)}
            alt={`图片大图预览，第 ${index + 1} 张`}
            draggable={false}
            onLoad={(event) =>
              setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
            }
            className={
              zoom === null
                ? 'max-h-[min(70vh,50rem)] max-w-full object-contain select-none'
                : 'max-w-none shrink-0 select-none'
            }
            style={
              zoom !== null && naturalSize
                ? { width: (naturalSize.width * zoom) / 100, height: (naturalSize.height * zoom) / 100 }
                : undefined
            }
          />
        </div>
      </div>
    </>
  )
}
