import * as React from 'react'
import { ImageOff } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'
import { ImageViewer, imageSource } from '../content/image-viewer'
import type { TurnImageGeneration } from '../model/turn-image-generations'
import './turn-image-gallery.css'

export function TurnImageGallery({
  generations,
  isLive,
  isPaused,
}: {
  generations: readonly TurnImageGeneration[]
  isLive: boolean
  isPaused: boolean
}) {
  const completed = generations.filter((item) => item.image)
  const images = completed.map((item) => item.image!)
  const [selectedId, setSelectedId] = React.useState<string>()
  const [previewIndex, setPreviewIndex] = React.useState<number | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const thumbnailsRef = React.useRef<HTMLDivElement>(null)
  const selectedThumbnailRef = React.useRef<HTMLButtonElement>(null)
  const selected = completed.find((item) => item.id === selectedId) ?? completed.at(-1)
  const index = selected ? completed.indexOf(selected) : -1

  React.useLayoutEffect(() => {
    const list = thumbnailsRef.current
    const thumbnail = selectedThumbnailRef.current
    if (!list || !thumbnail) return
    const top = thumbnail.offsetTop - 4
    const bottom = thumbnail.offsetTop + thumbnail.offsetHeight + 4
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }, [selected?.id])

  if (!generations.length) return null

  return (
    <section className="turn-image-gallery my-3 min-w-0" aria-label="本轮生成的图片">
      {selected && (
        <>
          <div className={cn('turn-image-gallery-layout', completed.length > 1 && 'has-thumbnails')}>
            <GeneratedImage
              key={selected.id}
              image={selected}
              index={index}
              triggerRef={triggerRef}
              onPreview={() => setPreviewIndex(index)}
            />
            {completed.length > 1 && (
              <div className="relative min-h-0">
                <div ref={thumbnailsRef} className="turn-image-thumbnails" aria-label="选择生成的图片">
                  {completed.map((item, imageIndex) => (
                    <button
                      key={item.id}
                      ref={selected.id === item.id ? selectedThumbnailRef : undefined}
                      type="button"
                      aria-label={`查看第 ${imageIndex + 1} 张生成图片`}
                      aria-pressed={selected.id === item.id}
                      onClick={() => setSelectedId(item.id)}
                      className={cn(
                        'aspect-square w-full shrink-0 overflow-hidden rounded-xl bg-secondary cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                        selected.id === item.id
                          ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                          : 'hover:opacity-80',
                      )}
                    >
                      <img
                        src={imageSource(item.image!)}
                        alt={`生成图片 ${imageIndex + 1} 的缩略图`}
                        className="size-full object-cover"
                        loading="lazy"
                        decoding="async"
                      />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <ImageViewer
            images={images}
            activeIndex={previewIndex}
            onActiveIndexChange={setPreviewIndex}
            triggerRef={triggerRef}
          />
        </>
      )}
      <div className="flex flex-wrap gap-3">
        {generations
          .filter((item) => !item.image)
          .map((item) => {
            const running = item.status === 'running' && isLive
            const label = running
              ? isPaused
                ? '已暂停等待'
                : item.editing
                  ? '正在编辑图片'
                  : '正在生成图片'
              : item.status === 'error'
                ? '图片生成失败'
                : item.status === 'running'
                  ? '图片生成已中断'
                  : '未返回可预览图片'
            return (
              <div
                key={item.id}
                className="image-generation-placeholder relative mt-2 flex aspect-square w-56 max-w-full flex-col justify-end overflow-hidden rounded-3xl bg-secondary p-4"
                aria-busy={running && !isPaused}
                data-running={running && !isPaused}
              >
                <div className="image-generation-dots" aria-hidden="true" />
                {item.error && (
                  <p className="relative mb-3 max-h-28 overflow-auto text-xs text-muted-foreground">{item.error}</p>
                )}
                <span
                  role="status"
                  className={
                    running && !isPaused
                      ? 'sr-only'
                      : 'relative ml-auto rounded-full border border-border bg-background px-3 py-1.5 text-xs text-foreground'
                  }
                >
                  {label}
                </span>
              </div>
            )
          })}
      </div>
    </section>
  )
}

function GeneratedImage({
  image,
  index,
  triggerRef,
  onPreview,
}: {
  image: TurnImageGeneration
  index: number
  triggerRef: React.RefObject<HTMLButtonElement | null>
  onPreview: () => void
}) {
  const [failed, setFailed] = React.useState(false)
  const [loaded, setLoaded] = React.useState(false)
  const [attempt, setAttempt] = React.useState(0)
  return (
    <button
      ref={triggerRef}
      type="button"
      aria-label={failed ? '图片加载失败，点击重新加载' : `放大第 ${index + 1} 张生成图片`}
      aria-busy={!loaded && !failed}
      onClick={() => {
        if (!failed) return onPreview()
        setFailed(false)
        setLoaded(false)
        setAttempt((value) => value + 1)
      }}
      className="relative flex aspect-square w-full min-w-0 items-center justify-center overflow-hidden rounded-3xl bg-secondary/40 cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {failed ? (
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <ImageOff className="size-4" />
          图片加载失败，点击重新加载
        </span>
      ) : (
        <>
          {!loaded && (
            <span role="status" className="absolute text-xs text-muted-foreground">
              正在加载图片
            </span>
          )}
          <img
            key={attempt}
            src={imageSource(image.image!)}
            alt={`本轮生成图片 ${index + 1}`}
            className={cn('size-full object-contain', !loaded && 'opacity-0')}
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        </>
      )}
    </button>
  )
}
