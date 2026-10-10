import { X } from 'lucide-react'
import type { ComposerProps } from './composer'

export function ComposerAttachments({
  attachments,
  onRemoveImage,
}: Pick<ComposerProps, 'attachments' | 'onRemoveImage'>) {
  return (
    <>
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2" aria-label="已附加图片">
          {attachments.map((image) => (
            <div
              key={image.id}
              className="group relative size-16 overflow-hidden rounded-lg border border-border bg-secondary/50 shadow-xs"
            >
              <img
                src={`data:${image.mimeType};base64,${image.data}`}
                alt="待发送图片"
                className="size-full object-cover"
              />
              <button
                type="button"
                aria-label="移除图片"
                onClick={() => onRemoveImage(image.id)}
                className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-black/70 text-white opacity-80 hover:opacity-100 transition-opacity cursor-pointer"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
