import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { ImageLibraryQuery, ImageLibraryItem } from '@pi-meme/contracts/image-library'
import { ImagesPage } from '../src/images/images-page'
import type { ImageLibrarySource } from '../src/images/image-library-data'

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe() {
        this.callback([{ contentRect: { width: 752 } }] as ResizeObserverEntry[], this as unknown as ResizeObserver)
      }
      disconnect() {}
      unobserve() {}
    },
  )
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe() {
        this.callback(
          [{ isIntersecting: true }] as IntersectionObserverEntry[],
          this as unknown as IntersectionObserver,
        )
      }
      disconnect() {}
      unobserve() {}
    },
  )
  HTMLElement.prototype.scrollTo = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function fixture() {
  let items: ImageLibraryItem[] = [
    {
      id: 'one',
      hostId: 'host',
      name: '白色小猫',
      prompt: '生成白色小猫',
      createdAt: '2026-10-29T01:00:00.000Z',
      width: 100,
      height: 150,
      model: 'image-model',
      operation: 'generate',
      session: { hostId: 'host', sessionId: 'session' },
    },
  ]
  const api = {
    list: vi.fn(async (input?: ImageLibraryQuery) => ({
      items: items.filter((item) => !input?.query || item.name.includes(input.query)),
      projects: [],
      scan: { running: false, completed: 0, total: 0, skipped: 0 },
    })),
    read: vi.fn(async (_id: string) => ({ dataUrl: 'data:image/png;base64,AA==', size: 1 })),
    rename: vi.fn(async (_id: string, name: string) => {
      items = items.map((item) => ({ ...item, name }))
    }),
    remove: vi.fn(async () => {
      items = []
    }),
  }
  const source: ImageLibrarySource = {
    id: 'local',
    label: '此计算机',
    connected: true,
    host: {
      capabilities: async () => ({ features: ['image-library'] }),
      imageLibrary: api,
      events: { subscribe: async () => () => {} },
    } as unknown as HostApi,
  }
  return {
    source,
    api,
    replace: (next: ImageLibraryItem[]) => {
      items = next
    },
    getItems: () => items,
  }
}

test('图像页支持预览与打开来源，未提供创建入口，隐藏再打开保留搜索', async () => {
  const { source } = fixture()
  const onOpenSession = vi.fn(async () => {})
  const props = { sources: [source], visible: true, onOpenSession }
  const view = render(<ImagesPage {...props} />)
  expect(screen.queryByRole('button', { name: '创建图像' })).not.toBeInTheDocument()
  fireEvent.click(await screen.findByRole('button', { name: '查看图像：白色小猫' }))
  expect(await screen.findByRole('dialog', { name: '图片预览' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '来源会话' }))
  await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('local', { hostId: 'host', sessionId: 'session' }))
  view.rerender(<ImagesPage {...props} visible={false} />)
  view.rerender(<ImagesPage {...props} />)
  fireEvent.change(screen.getByRole('textbox', { name: '搜索图像' }), { target: { value: '不存在' } })
  expect(await screen.findByText('没有找到匹配的图像')).toBeVisible()
  view.rerender(<ImagesPage {...props} visible={false} />)
  view.rerender(<ImagesPage {...props} />)
  expect(screen.getByRole('textbox', { name: '搜索图像' })).toHaveValue('不存在')
})

test('重命名和移除通过 Host API，移除前说明保留原文件', async () => {
  const { source, api } = fixture()
  const user = userEvent.setup()
  render(<ImagesPage sources={[source]} visible onOpenSession={async () => {}} />)
  await user.click(await screen.findByRole('button', { name: '白色小猫的操作' }))
  await user.click(screen.getByRole('menuitem', { name: '重命名' }))
  const input = await screen.findByRole('textbox', { name: '图像名称' })
  await user.clear(input)
  await user.type(input, '头像')
  await user.click(screen.getByRole('button', { name: '保存' }))
  expect(await screen.findByRole('button', { name: '查看图像：头像' })).toBeVisible()
  expect(api.rename).toHaveBeenCalledWith(
    'one',
    '头像',
    expect.objectContaining({ idempotencyKey: expect.any(String) }),
  )
  await user.click(screen.getByRole('button', { name: '头像的操作' }))
  await user.click(screen.getByRole('menuitem', { name: '从图像中移除' }))
  expect(await screen.findByText('移除后不再显示在图像库中，聊天记录和原文件仍会保留。')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '移除' }))
  expect(await screen.findByText('还没有图像')).toBeVisible()
  expect(api.remove).toHaveBeenCalledWith('one', expect.objectContaining({ idempotencyKey: expect.any(String) }))
})

test('预览加载期间刷新新增图片，仍打开原先点击的作品', async () => {
  const f = fixture()
  let resolveImage: (image: { dataUrl: string; size: number }) => void = () => {}
  f.api.read.mockImplementation((id) =>
    id === 'one'
      ? new Promise((resolve) => {
          resolveImage = resolve
        })
      : Promise.resolve({ dataUrl: 'data:image/png;base64,AA==', size: 1 }),
  )
  render(<ImagesPage sources={[f.source]} visible onOpenSession={async () => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: '查看图像：白色小猫' }))
  f.replace([{ ...f.getItems()[0], id: 'new', name: '新图片', createdAt: '2026-10-30T01:00:00.000Z' }, ...f.getItems()])
  fireEvent.click(screen.getByRole('button', { name: '刷新图像' }))
  await screen.findByRole('button', { name: '查看图像：新图片' })
  resolveImage({ dataUrl: 'data:image/png;base64,AA==', size: 1 })
  const dialog = await screen.findByRole('dialog', { name: '图片预览' })
  expect(dialog).toHaveTextContent('白色小猫')
  expect(dialog).toHaveTextContent('2 / 2')
})
