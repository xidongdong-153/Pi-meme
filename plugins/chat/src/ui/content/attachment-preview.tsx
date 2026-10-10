import * as React from 'react'
import type { PiImage } from '@pi-meme/contracts/pi'
import { Dialog, DialogContent, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { BrandMark } from '@pi-meme/ui/components/brand-mark'
import { cn } from '@pi-meme/ui/lib/utils'

export function AttachmentPreview({
  images,
  className,
}: {
  images: Array<PiImage & { id?: string }>
  className?: string
}) {
  const [activeImage, setActiveImage] = React.useState<string | null>(null)

  if (!images.length) return null

  const getSource = (image: PiImage) => {
    if (image.data.startsWith('data:') || image.data.startsWith('http')) return image.data
    return `data:${image.mimeType || 'image/png'};base64,${image.data}`
  }

  return (
    <>
      <div className={cn('flex flex-wrap gap-2 my-2', className)}>
        {images.map((image, index) => {
          const src = getSource(image)
          return (
            <button
              key={image.id ?? index}
              type="button"
              onClick={() => setActiveImage(src)}
              className="group relative size-16 overflow-hidden rounded-lg border border-border bg-secondary/60 hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer"
            >
              <img src={src} alt="用户附件图片" className="size-full object-cover" />
            </button>
          )
        })}
      </div>

      <Dialog open={Boolean(activeImage)} onOpenChange={(open) => !open && setActiveImage(null)}>
        <DialogContent className="max-w-3xl p-2 bg-card border-border overflow-hidden">
          <DialogTitle className="sr-only">图片预览</DialogTitle>
          {activeImage && (
            <div className="relative flex items-center justify-center max-h-[80vh] overflow-hidden rounded-md">
              <BrandMark size={24} className="absolute left-2 top-2" />
              <img
                src={activeImage}
                alt="图片大图预览"
                className="max-h-[75vh] w-auto object-contain rounded-md select-none"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
