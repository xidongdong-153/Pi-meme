import { useEffect, useRef, useState } from 'react'
import type { PiImage } from '@pi-meme/contracts/pi'
import { FileIcon } from '@pi-meme/ui/components/file-icon'
import { isImageLink, MessageImage } from '@pi-meme/chat/ui/content/message-image'
import { ImageViewer, imageSource } from '@pi-meme/chat/ui/content/image-viewer'
import type { SourceItem } from './sources-data'

function LocalImageThumbnail({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`预览图片：${alt}`}
        onClick={() => setOpen(true)}
        className="block size-full cursor-zoom-in overflow-hidden transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
      >
        <img src={src} alt={alt} className="size-full object-cover" />
      </button>
      <ImageViewer
        images={open ? [{ type: 'image', mimeType: '', data: src }] : []}
        activeIndex={open ? 0 : null}
        onActiveIndexChange={(index) => index === null && setOpen(false)}
        triggerRef={triggerRef}
      />
    </>
  )
}

function FilePreviewThumbnail({ file, name }: { file: File; name: string }) {
  const [url, setUrl] = useState(() => URL.createObjectURL(file))
  useEffect(() => {
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])

  return <LocalImageThumbnail src={url} alt={name} />
}

function PiImageThumbnail({ image, name }: { image: PiImage; name: string }) {
  const src = imageSource(image)
  return <LocalImageThumbnail src={src} alt={name} />
}

function SourceThumbnail({ item }: { item: SourceItem }) {
  if (item.image) {
    return <PiImageThumbnail image={item.image} name={item.name} />
  }
  if (item.preview && (item.preview.type.startsWith('image/') || isImageLink(item.name))) {
    return <FilePreviewThumbnail file={item.preview} name={item.name} />
  }
  if (item.path && (isImageLink(item.path) || isImageLink(item.name))) {
    return <MessageImage src={encodeURIComponent(item.path)} alt={item.name} className="m-0 size-full" />
  }
  return (
    <div className="flex size-full items-center justify-center bg-secondary/40">
      <FileIcon path={item.name} className="size-6 text-muted-foreground" />
    </div>
  )
}

export function SourcesPanel({ sources }: { sources: SourceItem[] }) {
  if (!sources.length) {
    return (
      <div className="p-4 text-xs text-muted-foreground" role="status">
        当前会话暂无附件
      </div>
    )
  }

  return (
    <div
      role="region"
      aria-label="来源附件列表"
      className="flex h-full min-h-0 flex-col overflow-y-auto divide-y divide-border/60 bg-background"
    >
      {sources.map((item) => (
        <div key={item.id} className="flex items-start gap-3 p-4">
          <div className="relative size-12 shrink-0 overflow-hidden rounded-lg border border-border bg-secondary/50 shadow-xs">
            <SourceThumbnail item={item} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-mono text-xs font-semibold text-foreground break-all select-text" title={item.name}>
              {item.name}
            </span>
            {item.path && (
              <span className="font-mono text-[11px] text-muted-foreground break-all select-text" title={item.path}>
                {item.path}
              </span>
            )}
            <span className="text-xs text-muted-foreground pt-0.5">{item.statusText}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
