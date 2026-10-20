import * as React from 'react'
import { X } from 'lucide-react'
import { FileIcon } from '@pi-meme/ui/components/file-icon'
import type { ComposerProps } from './composer'
import type { ComposerAttachment, ComposerImageAttachment, ComposerPendingAttachment } from './image-attachment'
import { ImageViewer, imageSource } from '../content/image-viewer'
import { isImageLink, MessageImage } from '../content/message-image'

function useAttachmentImages(
  attachments: (ComposerAttachment | ComposerPendingAttachment)[],
): ComposerImageAttachment[] {
  const urls = React.useRef(new Map<File, string>())
  const [sources, setSources] = React.useState(() => new Map<File, string>())

  React.useEffect(() => {
    const files = new Set(
      attachments.flatMap((attachment) =>
        attachment.type === 'file' && attachment.preview ? [attachment.preview] : [],
      ),
    )
    let changed = false
    for (const [file, url] of urls.current) {
      if (files.has(file)) continue
      URL.revokeObjectURL(url)
      urls.current.delete(file)
      changed = true
    }
    for (const file of files) {
      if (urls.current.has(file)) continue
      urls.current.set(file, URL.createObjectURL(file))
      changed = true
    }
    if (changed) setSources(new Map(urls.current))
  }, [attachments])

  React.useEffect(() => {
    const current = urls.current
    return () => {
      for (const url of current.values()) URL.revokeObjectURL(url)
      current.clear()
    }
  }, [])

  return attachments.flatMap((attachment) => {
    if (attachment.type === 'image') return [attachment]
    if (!attachment.preview) return []
    const data = sources.get(attachment.preview)
    return data
      ? [{ id: attachment.id, name: attachment.name, type: 'image', data, mimeType: attachment.preview.type }]
      : []
  })
}

export function ComposerAttachments({
  attachments,
  onRemoveImage,
  disabled,
  uploads = [],
  onCancelUpload,
}: Pick<ComposerProps, 'attachments' | 'onRemoveImage'> & {
  disabled?: boolean
  uploads?: ComposerPendingAttachment[]
  onCancelUpload?: (id: string) => void
}) {
  const items = [...attachments, ...uploads]
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const previews = useAttachmentImages(items)
  const [failedSources, setFailedSources] = React.useState(() => new Set<string>())
  const images = previews.filter((image) => !failedSources.has(imageSource(image)))
  const activeIndex = activeId === null ? -1 : images.findIndex((image) => image.id === activeId)

  if (activeId !== null && activeIndex === -1) setActiveId(null)

  return (
    <>
      {items.length > 0 && (
        <div className="mb-2 flex min-w-0 gap-2 overflow-x-auto pb-1" aria-label="已附加文件">
          {items.map((attachment) => {
            const progress = 'progress' in attachment ? attachment.progress : undefined
            const imageIndex = images.findIndex((image) => image.id === attachment.id)
            const image = images[imageIndex]
            const hostImage =
              attachment.type === 'file' &&
              !attachment.preview &&
              'path' in attachment &&
              isImageLink(encodeURIComponent(attachment.name))
                ? attachment
                : undefined
            const name = attachment.name || `图片 ${previews.findIndex((preview) => preview.id === attachment.id) + 1}`
            const iconPath = attachment.name || 'image.png'
            const content = (
              <>
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-background/70">
                  {image ? (
                    <img
                      src={imageSource(image)}
                      alt={name}
                      onError={() => setFailedSources((current) => new Set(current).add(imageSource(image)))}
                      className="size-full object-cover"
                    />
                  ) : hostImage ? (
                    <MessageImage src={encodeURIComponent(hostImage.path)} alt={name} className="m-0 size-full" />
                  ) : (
                    <FileIcon path={iconPath} className="size-8" />
                  )}
                </div>
                <div className="flex h-7 shrink-0 items-center gap-1.5 bg-background/50 px-2 text-xs" title={name}>
                  <FileIcon path={iconPath} className="size-3.5" />
                  <span className="min-w-0 truncate">{name}</span>
                </div>
              </>
            )

            return (
              <div
                key={attachment.id}
                className="relative h-28 w-32 shrink-0 overflow-hidden rounded-lg border border-border bg-secondary/50 shadow-xs"
              >
                {image ? (
                  <button
                    type="button"
                    aria-label={`预览第 ${imageIndex + 1} 张图片：${name}`}
                    onClick={(event) => {
                      triggerRef.current = event.currentTarget
                      setActiveId(attachment.id)
                    }}
                    className="flex size-full cursor-pointer flex-col text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    {content}
                  </button>
                ) : (
                  <div className="flex size-full flex-col">{content}</div>
                )}
                {progress !== undefined && (
                  <div className="pointer-events-none absolute inset-x-0 top-0 flex h-[calc(100%-1.75rem)] items-center justify-center bg-black/40">
                    <div
                      role="progressbar"
                      aria-label={`上传文件：${name}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progress}
                      aria-valuetext={progress === 100 ? '上传完成，正在处理' : `${progress}%`}
                      className="relative flex size-12 items-center justify-center rounded-full bg-black/60 text-white"
                    >
                      <svg viewBox="0 0 40 40" className="absolute inset-0 size-full -rotate-90" aria-hidden="true">
                        <circle
                          cx="20"
                          cy="20"
                          r="17"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          opacity="0.25"
                        />
                        <circle
                          cx="20"
                          cy="20"
                          r="17"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          pathLength="100"
                          strokeDasharray="100"
                          strokeDashoffset={100 - progress}
                        />
                      </svg>
                      <span className="text-[10px] font-medium tabular-nums">{progress}%</span>
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={
                    progress !== undefined
                      ? `取消上传：${name}`
                      : `移除${image || hostImage ? '图片' : '文件'}：${name}`
                  }
                  onClick={() =>
                    progress !== undefined ? onCancelUpload?.(attachment.id) : onRemoveImage(attachment.id)
                  }
                  className="absolute right-1 top-1 flex size-5 cursor-pointer items-center justify-center rounded-full bg-black/70 text-white opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-30"
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <ImageViewer
        images={images}
        activeIndex={activeIndex === -1 ? null : activeIndex}
        onActiveIndexChange={(index) => setActiveId(index === null ? null : (images[index]?.id ?? null))}
        triggerRef={triggerRef}
      />
    </>
  )
}
