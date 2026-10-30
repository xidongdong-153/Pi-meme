import type { HostApi } from '@pi-meme/contracts/app-host'
import type { ImageLibraryItem, ImageLibraryPage } from '@pi-meme/contracts/image-library'

export type ImageLibrarySource = { id: string; label: string; connected: boolean; host: HostApi }
export type GalleryImage = ImageLibraryItem & { serviceId: string; hostLabel: string }
export const galleryKey = (item: GalleryImage) => `${item.serviceId}:${item.id}`
export function compareImages(a: ImageLibraryItem, b: ImageLibraryItem) {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id) || b.hostId.localeCompare(a.hostId)
}

export class ImageLibraryFeed {
  readonly sources: Array<{
    source: ImageLibrarySource
    buffer: GalleryImage[]
    cursor?: string
    done: boolean
    checked: boolean
    page?: ImageLibraryPage
    error?: string
  }>
  readonly items: GalleryImage[] = []

  constructor(
    sources: ImageLibrarySource[],
    private readonly input: { query: string; projectId?: string },
  ) {
    this.sources = sources.map((source) => ({
      source,
      buffer: [],
      done: !source.connected,
      checked: false,
      error: source.connected ? undefined : '未连接，结果不完整',
    }))
  }

  get hasMore() {
    return this.sources.some((state) => !state.done || state.buffer.length > 0)
  }

  async more(count = 40) {
    for (let index = 0; index < count; index++) {
      await Promise.all(
        this.sources
          .filter((state) => !state.done && !state.buffer.length)
          .map(async (state) => {
            try {
              if (!state.checked) {
                const caps = await state.source.host.capabilities()
                if (!caps.features.includes('image-library') || !state.source.host.imageLibrary)
                  throw new Error('当前服务版本不支持图像库')
                state.checked = true
              }
              const page = await state.source.host.imageLibrary!.list({
                ...this.input,
                cursor: state.cursor,
                limit: 40,
              })
              state.page = page
              state.buffer = page.items.map((item) => ({
                ...item,
                serviceId: state.source.id,
                hostLabel: state.source.label,
              }))
              state.done = !page.nextCursor || page.nextCursor === state.cursor
              state.cursor = page.nextCursor
            } catch (cause) {
              state.error = cause instanceof Error ? cause.message : '读取图像失败'
              state.done = true
            }
          }),
      )
      const next = this.sources
        .filter((state) => state.buffer.length)
        .sort((a, b) => compareImages(a.buffer[0], b.buffer[0]))[0]
      if (!next) break
      const image = next.buffer.shift()!
      if (!this.items.some((item) => galleryKey(item) === galleryKey(image))) this.items.push(image)
    }
    return [...this.items]
  }
}

export function imageMasonry(items: ImageLibraryItem[], width: number) {
  const gap = 16
  const columns = Math.max(1, Math.floor((width + gap) / 256))
  const cardWidth = Math.max(1, (width - gap * (columns - 1)) / columns)
  const heights = Array.from<number>({ length: columns }).fill(0)
  const positions = items.map((item) => {
    const column = heights.indexOf(Math.min(...heights))
    const height = (cardWidth * item.height) / item.width
    const position = { left: column * (cardWidth + gap), top: heights[column], width: cardWidth, height }
    heights[column] += height + gap
    return position
  })
  return { positions, height: Math.max(0, ...heights) }
}

/** 同页卡片与预览共享读取队列，避免同时传输大量原图。 */
export class GalleryImageLoader {
  private running = 0
  private waiting: Array<() => void> = []
  private pending = new Map<string, Promise<string>>()
  private cache = new Map<string, string>()

  load(item: GalleryImage, source: ImageLibrarySource): Promise<string> {
    const key = galleryKey(item)
    const cached = this.cache.get(key)
    if (cached) return Promise.resolve(cached)
    const pending = this.pending.get(key)
    if (pending) return pending
    const request = (async () => {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve)
        this.drain()
      })
      try {
        if (!source.connected || !source.host.imageLibrary) throw new Error('图片所属服务未连接')
        const { dataUrl } = await source.host.imageLibrary.read(item.id)
        this.cache.set(key, dataUrl)
        while (
          [...this.cache.values()].reduce((size, value) => size + value.length * 2, 0) > 32 * 1024 * 1024 ||
          this.cache.size > 40
        )
          this.cache.delete(this.cache.keys().next().value!)
        return dataUrl
      } finally {
        this.running--
        this.pending.delete(key)
        this.drain()
      }
    })()
    this.pending.set(key, request)
    return request
  }

  invalidate(item: GalleryImage) {
    this.cache.delete(galleryKey(item))
  }

  private drain() {
    while (this.running < 4 && this.waiting.length) {
      this.running++
      this.waiting.shift()!()
    }
  }
}
