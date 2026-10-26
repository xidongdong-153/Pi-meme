import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserAnnotation,
  BrowserEvent,
  BrowserPlatform,
  BrowserSnapshot,
  BrowserTab,
  BrowserWorkspace,
} from '@pi-meme/contracts/browser'
import { useBrowser } from '@pi-meme/browser/ui/use-browser'

afterEach(cleanup)
const snapshot: BrowserSnapshot = {
  settings: {
    links: 'external',
    localLinks: 'internal',
    search: 'bing',
    fullUrl: false,
    screenshots: 'element',
    restore: true,
    downloadDirectory: '',
    askDownload: true,
  },
  history: [],
  downloads: [],
  permissions: [],
}
const blank = (): BrowserWorkspace => ({ tabs: [], annotations: [] })
function fixture() {
  const values = new Map<string, BrowserWorkspace>()
  let listener: ((event: BrowserEvent) => void) | undefined
  const platform = {
    snapshot: async () => snapshot,
    workspace: vi.fn(async (owner: string) => structuredClone(values.get(owner) ?? blank())),
    saveWorkspace: vi.fn(async (owner: string, value: BrowserWorkspace) => {
      values.set(owner, structuredClone(value))
    }),
    onEvent: (callback: (event: BrowserEvent) => void) => {
      listener = callback
      return () => {
        listener = undefined
      }
    },
    rebind: vi.fn(),
    create: vi.fn(async (owner: string, id: string, url = 'about:blank'): Promise<BrowserTab> => ({
      owner,
      id,
      url,
      title: '网页',
      documentId: 1,
      loading: false,
      canGoBack: false,
      canGoForward: false,
    })),
    close: vi.fn(),
  }
  const callbacks = {
    onAnnotation: vi.fn(),
    onAnnotationRemove: vi.fn(),
    onDiscard: vi.fn(),
    onSubmit: vi.fn(),
    onSettings: vi.fn(),
    onOpen: vi.fn(),
  }
  const hook = (owner: string) =>
    useBrowser({ platform: platform as unknown as BrowserPlatform, owner, active: true, ...callbacks })
  return { values, platform, callbacks, hook, emit: (event: BrowserEvent) => listener?.(event) }
}
function note(id: string, comment: string): BrowserAnnotation {
  return {
    id,
    tabId: 'tab',
    documentId: 1,
    url: 'https://example.com/',
    title: '网页',
    capturedAt: new Date().toISOString(),
    kind: 'element',
    text: '内容',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    viewport: { width: 100, height: 100, scale: 1, scrollX: 0, scrollY: 0 },
    comment,
  }
}
describe('浏览器工作区异步隔离', () => {
  it('迟到的新建请求保存在原聊天，不打开到新聊天', async () => {
    const f = fixture()
    let resolve!: (tab: BrowserTab) => void
    f.platform.create.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const { result, rerender } = renderHook(({ owner }) => f.hook(owner), { initialProps: { owner: 'a' } })
    await waitFor(() => expect(result.current.ready).toBe(true))
    let pending: Promise<void>
    act(() => {
      pending = result.current.create('https://example.com/')
    })
    rerender({ owner: 'b' })
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      resolve({
        owner: 'a',
        id: 'late-tab',
        url: 'https://example.com/',
        title: '原聊天网页',
        documentId: 1,
        loading: false,
        canGoBack: false,
        canGoForward: false,
      })
      await pending!
    })
    await waitFor(() => expect(f.values.get('a')?.tabs).toHaveLength(1))
    expect(result.current.tabs).toEqual([])
    expect(f.callbacks.onOpen).not.toHaveBeenCalled()
  })
  it('保存失败保持未保存状态，重试成功后解除', async () => {
    const f = fixture()
    const { result } = renderHook(() => f.hook('a'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    f.platform.saveWorkspace.mockRejectedValueOnce(new Error('磁盘写入失败'))
    await act(() => result.current.create())
    await waitFor(() => expect(result.current.error).toContain('尚未保存'))
    expect(result.current.hasUnstored()).toBe(true)
    act(() => result.current.retrySave())
    await waitFor(() => expect(result.current.error).toBe(''))
    expect(result.current.hasUnstored()).toBe(false)
  })
  it('重新保存同 ID 批注保持顺序，单条删除同步当前聊天', async () => {
    const f = fixture()
    const { result } = renderHook(() => f.hook('a'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => {
      f.emit({ type: 'annotation', owner: 'a', annotation: note('one', '原评论') })
      f.emit({ type: 'annotation', owner: 'a', annotation: note('two', '第二条') })
      f.emit({ type: 'annotation', owner: 'a', annotation: note('one', '修改后') })
    })
    expect(result.current.workspace?.annotations.map((item) => [item.id, item.comment])).toEqual([
      ['one', '修改后'],
      ['two', '第二条'],
    ])
    act(() => f.emit({ type: 'annotation-remove', owner: 'a', id: 'one' }))
    expect(result.current.workspace?.annotations.map((item) => item.id)).toEqual(['two'])
    expect(f.callbacks.onAnnotationRemove).toHaveBeenCalledWith('one')
  })
})
