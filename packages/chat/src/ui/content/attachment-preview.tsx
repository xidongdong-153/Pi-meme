import * as React from 'react'
import type { PiImage } from '@pi-meme/contracts/pi'
import { cn } from '@pi-meme/ui/lib/utils'
import { ImageViewer, imageSource } from './image-viewer'

export function AttachmentPreview({
  images,
  className,
}: {
  images: Array<PiImage & { id?: string }>
  className?: string
}) {
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)

  if (activeIndex !== null && !images.length) setActiveIndex(null)

  if (!images.length) return null

  return (
    <>
      <div className={cn('flex flex-wrap gap-2 my-2', className)}>
        {images.map((image, index) => {
          const src = imageSource(image)
          return (
            <button
              key={image.id ?? index}
              type="button"
              aria-label={`预览第 ${index + 1} 张图片`}
              onClick={(event) => {
                triggerRef.current = event.currentTarget
                setActiveIndex(index)
              }}
              className="group relative size-16 overflow-hidden rounded-lg border border-border bg-secondary/60 hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer"
            >
              <img src={src} alt="用户附件图片" className="size-full object-cover" />
            </button>
          )
        })}
      </div>

      <ImageViewer
        images={images}
        activeIndex={activeIndex}
        onActiveIndexChange={setActiveIndex}
        triggerRef={triggerRef}
      />
    </>
  )
}
