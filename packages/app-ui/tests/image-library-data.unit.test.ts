import { expect, test, vi } from 'vitest'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { ImageLibraryItem } from '@pi-meme/contracts/image-library'
import {
  GalleryImageLoader,
  ImageLibraryFeed,
  galleryKey,
  imageMasonry,
  type GalleryImage,
  type ImageLibrarySource,
} from '../src/images/image-library-data'

function source(id: string, dates: string[]): ImageLibrarySource {
  const items: ImageLibraryItem[] = dates.map((createdAt, index) => ({
    id: String(index),
    hostId: id,
    name: id,
    prompt: '',
    createdAt,
    width: 100,
    height: 100,
    model: 'test',
    operation: 'generate',
    session: { hostId: id, sessionId: 'session' },
  }))
  return {
    id,
    label: id,
    connected: true,
    host: {
      capabilities: vi.fn(async () => ({ features: ['image-library'] })),
      imageLibrary: {
        list: vi.fn(async (input) => {
          const offset = Number(input?.cursor || 0)
          return {
            items: items.slice(offset, offset + 2),
            nextCursor: offset + 2 < items.length ? String(offset + 2) : undefined,
            projects: [],
            scan: { running: false, completed: 0, total: 0, skipped: 0 },
          }
        }),
      },
    } as unknown as HostApi,
  }
}

test('多 Host 分页在页边界仍按时间合并，无重复或遗漏，离线不请求', async () => {
  const one = source('one', ['09', '07', '05', '03'])
  const two = source('two', ['08', '06', '04', '02'])
  const offline = { ...source('offline', ['10']), connected: false }
  const feed = new ImageLibraryFeed([one, two, offline], { query: '' })
  expect((await feed.more(3)).map((item) => item.createdAt)).toEqual(['09', '08', '07'])
  const all = await feed.more(8)
  expect(all.map((item) => item.createdAt)).toEqual(['09', '08', '07', '06', '05', '04', '03', '02'])
  expect(new Set(all.map(galleryKey)).size).toBe(8)
  expect(feed.hasMore).toBe(false)
  expect(offline.host.capabilities).not.toHaveBeenCalled()
})

test('单个 Host 接口失败或版本较旧时保留其他来源结果', async () => {
  const good = source('good', ['09'])
  const old = source('old', ['10'])
  vi.mocked(old.host.capabilities).mockResolvedValue({ features: [] } as never)
  const feed = new ImageLibraryFeed([good, old], { query: '' })
  expect((await feed.more()).map((item) => item.hostId)).toEqual(['good'])
  expect(feed.sources[1].error).toContain('不支持')
})

test('原图读取合并重复请求且最多并发四张', async () => {
  const host = source('host', [])
  const resolves: Array<() => void> = []
  const read = vi.fn(
    () =>
      new Promise<{ dataUrl: string; size: number }>((resolve) =>
        resolves.push(() => resolve({ dataUrl: 'data:image/png;base64,AA==', size: 1 })),
      ),
  )
  host.host.imageLibrary!.read = read
  const loader = new GalleryImageLoader()
  const item = (id: string) => ({ id, serviceId: 'host' }) as GalleryImage
  const pending = Array.from({ length: 6 }, (_, index) => loader.load(item(String(index)), host))
  expect(loader.load(item('0'), host)).toBe(pending[0])
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4))
  resolves.splice(0).forEach((resolve) => resolve())
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(6))
  resolves.splice(0).forEach((resolve) => resolve())
  await Promise.all(pending)
})

test('瀑布流保持宽高比并将后续图片放入最短列', () => {
  const result = imageMasonry(
    [
      { width: 100, height: 200 },
      { width: 100, height: 100 },
      { width: 100, height: 100 },
    ] as ImageLibraryItem[],
    496,
  )
  expect(result.positions).toEqual([
    { left: 0, top: 0, width: 240, height: 480 },
    { left: 256, top: 0, width: 240, height: 240 },
    { left: 256, top: 256, width: 240, height: 240 },
  ])
})
