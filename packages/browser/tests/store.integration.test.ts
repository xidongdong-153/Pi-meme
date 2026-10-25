import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BrowserAnnotation } from '@pi-meme/contracts/browser'
import { BrowserStore } from '../src/server/store'

const directories: string[] = []
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0SsAAAAASUVORK5CYII='
const annotation: BrowserAnnotation = {
  id: 'annotation',
  tabId: 'tab',
  documentId: 1,
  url: 'https://example.com/',
  title: '测试网页',
  capturedAt: '2026-10-25T00:00:00Z',
  kind: 'element',
  tag: 'button',
  text: '按钮',
  comment: '调整间距',
  rect: { x: 2, y: 3, width: 10, height: 10 },
  viewport: { width: 100, height: 100, scale: 2, scrollX: 0, scrollY: 0 },
  image: { type: 'image', mimeType: 'image/png', data: png },
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
async function create() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-browser-store-'))
  directories.push(directory)
  const store = new BrowserStore(directory)
  await store.initialize()
  return { store, directory }
}

describe('浏览器持久存储', () => {
  it('重启后恢复批注和独立图片，保持聊天隔离', async () => {
    const { store, directory } = await create()
    await store.saveWorkspace('chat-a', {
      tabs: [
        {
          id: 'tab',
          owner: 'chat-a',
          url: 'https://example.com/',
          title: '网页',
          documentId: 1,
          loading: true,
          canGoBack: true,
          canGoForward: false,
        },
      ],
      annotations: [annotation],
      editor: { ...annotation, id: 'editing', comment: '尚未加入' },
    })
    const file = (await readdir(directory)).find((name) => name.startsWith('workspace-'))!
    expect(await readFile(path.join(directory, file), 'utf8')).not.toContain(png)
    const restored = new BrowserStore(directory)
    await restored.initialize()
    expect((await restored.workspace('chat-a')).annotations).toEqual([annotation])
    expect((await restored.workspace('chat-a')).editor?.comment).toBe('尚未加入')
    expect((await restored.workspace('chat-a')).tabs[0].loading).toBe(false)
    expect(await restored.workspace('chat-b')).toEqual({ tabs: [], annotations: [] })
  })
  it('原子保存设置并拒绝无效路径、权限与截图', async () => {
    const { store, directory } = await create()
    await Promise.all([
      store.settings({ search: 'google' }),
      store.settings({ askDownload: false }),
      store.permission({ origin: 'https://example.com', permission: 'media', value: 'deny' }),
    ])
    expect(store.snapshot().settings).toMatchObject({ search: 'google', askDownload: false })
    expect(() => store.settings({ downloadDirectory: '../outside' })).toThrow()
    expect(() =>
      store.permission({ origin: 'https://example.com/path', permission: 'media', value: 'allow' }),
    ).toThrow()
    await expect(
      store.saveWorkspace('chat', {
        tabs: [],
        annotations: [{ ...annotation, image: { type: 'image', mimeType: 'image/png', data: 'AAAA' } }],
      }),
    ).rejects.toThrow('PNG')
    const restored = new BrowserStore(directory)
    await restored.initialize()
    expect(restored.snapshot()).toEqual(store.snapshot())
  })
  it('共享截图在最后一个草稿移除后才删除', async () => {
    const { store, directory } = await create()
    await store.saveWorkspace('a', { tabs: [], annotations: [annotation] })
    await store.saveWorkspace('b', { tabs: [], annotations: [annotation] })
    await store.saveWorkspace('a', { tabs: [], annotations: [] })
    expect((await readdir(directory)).filter((file) => file.endsWith('.png'))).toHaveLength(1)
    await store.saveWorkspace('b', { tabs: [], annotations: [] })
    expect((await readdir(directory)).filter((file) => file.endsWith('.png'))).toHaveLength(0)
  })

  it('绑定正式会话保留内容且不会覆盖已有批注', async () => {
    const { store } = await create()
    await store.saveWorkspace('draft', { tabs: [], annotations: [annotation] })
    await store.saveWorkspace('session', { tabs: [], annotations: [{ ...annotation, id: 'existing' }] })
    await store.rebind('draft', 'session')
    expect((await store.workspace('session')).annotations.map((item) => item.id)).toEqual(['existing', 'annotation'])
    expect((await store.workspace('draft')).annotations).toEqual([])
  })
  it('重启后把进行中的下载标记为中断，删除记录保留工作区', async () => {
    const { store, directory } = await create()
    await store.saveWorkspace('session', { tabs: [], annotations: [annotation] })
    await store.download({
      id: 'download',
      url: 'https://example.com/file',
      name: 'file.txt',
      path: '/tmp/file.txt',
      received: 10,
      total: 20,
      state: 'progressing',
      createdAt: '2026-10-25T00:00:00Z',
    })
    const restored = new BrowserStore(directory)
    await restored.initialize()
    expect(restored.snapshot().downloads[0].state).toBe('interrupted')
    await restored.clearDownloads()
    expect(restored.snapshot().downloads).toEqual([])
    expect((await restored.workspace('session')).annotations[0].image?.data).toBe(png)
  })
})
