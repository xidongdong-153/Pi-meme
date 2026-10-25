import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPlatform, BrowserSnapshot, BrowserTab, BrowserWorkspace } from '@pi-meme/contracts/browser'
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
  const platform = {
    snapshot: async () => snapshot,
    workspace: vi.fn(async (owner: string) => structuredClone(values.get(owner) ?? blank())),
    saveWorkspace: vi.fn(async (owner: string, value: BrowserWorkspace) => {
      values.set(owner, structuredClone(value))
    }),
    onEvent: () => () => {},
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
    onDiscard: vi.fn(),
    onSubmit: vi.fn(),
    onSettings: vi.fn(),
    onOpen: vi.fn(),
  }
  const hook = (owner: string) =>
    useBrowser({ platform: platform as unknown as BrowserPlatform, owner, active: true, ...callbacks })
  return { values, platform, callbacks, hook }
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
})
