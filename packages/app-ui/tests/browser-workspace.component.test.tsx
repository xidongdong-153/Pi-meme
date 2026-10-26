import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserAnnotation,
  BrowserCommand,
  BrowserEvent,
  BrowserPlatform,
  BrowserSnapshot,
  BrowserTab,
  BrowserWorkspace,
} from '@pi-meme/contracts/browser'
import { useBrowser } from '@pi-meme/browser/ui/use-browser'
import { BrowserPanel } from '@pi-meme/browser/ui/browser-panel'

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

function renderBrowserPanel() {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const listeners = new Set<(event: BrowserEvent) => void>()
  const tab: BrowserTab = {
    id: 'tab',
    owner: 'chat',
    url: 'https://example.com/',
    title: '网页',
    documentId: 1,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    zoom: 1,
  }
  const platform = {
    snapshot: async () => snapshot,
    create: vi.fn(async () => tab),
    present: vi.fn(async () => null),
    preview: vi.fn<BrowserPlatform['preview']>(async () => null),
    command: vi.fn<BrowserPlatform['command']>(async () => {}),
    onEvent: (listener: (event: BrowserEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  render(
    <BrowserPanel platform={platform as unknown as BrowserPlatform} tab={tab} annotations={[]} onSettings={vi.fn()} />,
  )
  return { platform, emit: (event: BrowserEvent) => act(() => listeners.forEach((listener) => listener(event))) }
}

async function openBrowserMenu() {
  fireEvent.pointerDown(screen.getByRole('button', { name: '更多浏览器操作' }), { button: 0, ctrlKey: false })
  return screen.findByRole('menuitem', { name: '在页面中查找' })
}

describe('浏览器菜单交互', () => {
  it('地址栏聚焦后选中完整网址，粘贴时不会留下旧网址前缀', async () => {
    renderBrowserPanel()
    const input = screen.getByRole('textbox', { name: '搜索或输入网址' }) as HTMLInputElement
    act(() => input.focus())
    expect(input.value).toBe('https://example.com/')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
  })

  it('从菜单打开查找后输入框为空并获得焦点，保留地址栏', async () => {
    renderBrowserPanel()
    fireEvent.click(await openBrowserMenu())
    const input = await screen.findByRole('textbox', { name: '在页面中查找' })
    await waitFor(() => expect(input).toHaveFocus())
    expect(input).toHaveValue('')
    expect(screen.getByRole('textbox', { name: '搜索或输入网址' })).toBeInTheDocument()
  })

  it('连续缩放立即显示累计值，不等待原生状态回传', async () => {
    const { platform } = renderBrowserPanel()
    await openBrowserMenu()
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    expect(screen.getByRole('button', { name: '130%' })).toBeInTheDocument()
    expect(platform.command.mock.calls.filter(([, command]) => command.type === 'zoom')).toEqual([
      ['tab', { type: 'zoom', value: 1.1 }],
      ['tab', { type: 'zoom', value: 1.2 }],
      ['tab', { type: 'zoom', value: 1.3 }],
    ])
  })

  it('菜单隐藏原生视图时不会丢弃第一次缩放的新预览', async () => {
    let frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const nextFrame = () =>
      act(async () => {
        const pending = frames
        frames = []
        pending.forEach((callback) => callback(0))
      })
    vi.stubGlobal(
      'Image',
      class {
        src = ''
        async decode() {}
      },
    )
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      top: 0,
      left: 0,
      right: 400,
      bottom: 300,
      toJSON: () => ({}),
    })
    const { platform } = renderBrowserPanel()
    platform.preview.mockResolvedValue('data:image/png;base64,before')
    await act(async () => {
      fireEvent.pointerDown(screen.getByRole('button', { name: '更多浏览器操作' }), { button: 0, ctrlKey: false })
    })
    await nextFrame()
    let resolve!: () => void
    platform.command.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done
        }),
    )
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    await nextFrame()
    expect(platform.present).toHaveBeenCalledWith('tab', null, 'dark', expect.any(Object), false)
    platform.preview.mockResolvedValue('data:image/png;base64,after')
    await act(async () => {
      resolve()
    })
    await waitFor(() =>
      expect(screen.getByRole('img', { name: '网页预览', hidden: true })).toHaveAttribute(
        'src',
        'data:image/png;base64,after',
      ),
    )
  })

  it('查找显示当前词的结果，Enter 和 Shift+Enter 跳转，Esc 清除高亮并返回网页', async () => {
    const { platform, emit } = renderBrowserPanel()
    fireEvent.click(await openBrowserMenu())
    const input = await screen.findByRole('textbox', { name: '在页面中查找' })
    fireEvent.change(input, { target: { value: '苹果' } })
    emit({ type: 'find-result', tabId: 'other', text: '苹果', active: 1, matches: 99 })
    emit({ type: 'find-result', tabId: 'tab', text: '旧词', active: 1, matches: 99 })
    expect(screen.getByRole('status')).toHaveTextContent('查找中')
    emit({ type: 'find-result', tabId: 'tab', text: '苹果', active: 1, matches: 3 })
    expect(screen.getByRole('status')).toHaveTextContent('1/3')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(platform.command).toHaveBeenLastCalledWith('tab', { type: 'find', text: '苹果', next: true, forward: true })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(platform.command).toHaveBeenLastCalledWith('tab', { type: 'find', text: '苹果', next: true, forward: false })
    const calls = platform.command.mock.calls.length
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(platform.command).toHaveBeenCalledTimes(calls)
    fireEvent.change(input, { target: { value: '不存在' } })
    emit({ type: 'find-result', tabId: 'tab', text: '不存在', active: 0, matches: 0 })
    expect(screen.getByRole('status')).toHaveTextContent('无匹配')
    expect(screen.getByRole('button', { name: '下一个匹配' })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: '在页面中查找' })).not.toBeInTheDocument()
    expect(platform.command).toHaveBeenCalledWith('tab', { type: 'find', text: '' })
    expect(platform.command).toHaveBeenLastCalledWith('tab', { type: 'focus' })
  })

  it('较早缩放请求失败不回退后来点击的值', async () => {
    const { platform } = renderBrowserPanel()
    await openBrowserMenu()
    let reject!: (cause: Error) => void
    platform.command.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail
        }),
    )
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    await act(async () => {
      reject(new Error('旧请求失败'))
    })
    expect(screen.getByRole('button', { name: '120%' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    expect(platform.command).toHaveBeenLastCalledWith('tab', { type: 'zoom', value: 1.3 } satisfies BrowserCommand)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
