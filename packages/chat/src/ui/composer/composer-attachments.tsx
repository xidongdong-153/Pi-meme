import * as React from 'react'
import { X } from 'lucide-react'
import type { ComposerProps } from './composer'
import { ImageViewer, imageSource } from '../content/image-viewer'

export function ComposerAttachments({
  attachments,
  onRemoveImage,
  disabled,
}: Pick<ComposerProps, 'attachments' | 'onRemoveImage'> & { disabled?: boolean }) {
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)

  if (activeIndex !== null && !attachments.length) setActiveIndex(null)

  return (
    <>
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2" aria-label="已附加图片">
          {attachments.map((image, index) => (
            <div
              key={image.id}
              className="group relative size-16 overflow-hidden rounded-lg border border-border bg-secondary/50 shadow-xs"
            >
              <button
                type="button"
                aria-label={`预览第 ${index + 1} 张图片`}
                onClick={(event) => {
                  triggerRef.current = event.currentTarget
                  setActiveIndex(index)
                }}
                className="size-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <img src={imageSource(image)} alt="待发送图片" className="size-full object-cover" />
              </button>
              <button
                type="button"
                disabled={disabled}
                aria-label="移除图片"
                onClick={() => onRemoveImage(image.id)}
                className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-black/70 text-white opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-opacity cursor-pointer"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <ImageViewer
        images={attachments}
        activeIndex={activeIndex}
        onActiveIndexChange={setActiveIndex}
        triggerRef={triggerRef}
      />
    </>
  )
}
