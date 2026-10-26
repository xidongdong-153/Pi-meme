import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserAnnotation, BrowserSnapshot, BrowserWorkspace } from '@pi-meme/contracts/browser'
import { registerBrowserRuntime } from '../src/main/browser/browser-runtime'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  views: [] as Array<{
    webContents: {
      mainFrame: { url: string }
      close: ReturnType<typeof vi.fn>
      on: ReturnType<typeof vi.fn>
      send: ReturnType<typeof vi.fn>
      capturePage: ReturnType<typeof vi.fn>
      executeJavaScript: ReturnType<typeof vi.fn>
      setBackgroundThrottling: ReturnType<typeof vi.fn>
      findInPage: ReturnType<typeof vi.fn>
      stopFindInPage: ReturnType<typeof vi.fn>
      focus: ReturnType<typeof vi.fn>
    }
    setVisible: ReturnType<typeof vi.fn>
    setBounds: ReturnType<typeof vi.fn>
  }>,
  check: undefined as undefined | ((web: unknown, permission: string, origin: string) => boolean),
  fetch: vi.fn(),
  loadURL: vi.fn<(url: string) => Promise<void>>(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/browser-downloads' },
  ipcMain: {
    handle: (channel: string, callback: (event: unknown, ...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, callback),
    on: (channel: string, callback: (event: unknown, ...args: unknown[]) => unknown) =>
      mocks.listeners.set(channel, callback),
  },
  session: {
    fromPartition: () => ({
      setPermissionCheckHandler: (callback: typeof mocks.check) => {
        mocks.check = callback
      },
      setPermissionRequestHandler: () => {},
      on: () => {},
      clearCache: vi.fn(),
      clearStorageData: vi.fn(),
      fetch: mocks.fetch,
    }),
  },
  BrowserWindow: class {
    static fromWebContents() {
      return null
    }
  },
  WebContentsView: class {
    zoomFactor = 1
    findRequest = 0
    webContents = {
      mainFrame: { url: '' },
      getURL: () => this.webContents.mainFrame.url,
      getTitle: () => '测试网页',
      isLoading: () => false,
      isDestroyed: () => false,
      close: vi.fn(),
      focus: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: async (url: string) => {
        this.webContents.mainFrame.url = url
        await mocks.loadURL(url)
      },
      send: vi.fn(),
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      getZoomFactor: () => this.zoomFactor,
      setZoomFactor: vi.fn((value: number) => (this.zoomFactor = value)),
      findInPage: vi.fn(() => ++this.findRequest),
      stopFindInPage: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      executeJavaScript: vi.fn(async () => {}),
      capturePage: vi.fn(async () => ({
        getSize: () => ({ width: 800 }),
        resize: () => ({ toDataURL: () => `data:image/png;base64,${Math.round(this.zoomFactor * 100)}` }),
      })),
    }
    setBackgroundColor = vi.fn()
    setVisible = vi.fn()
    setBounds = vi.fn()
    constructor() {
      mocks.views.push(this)
    }
  },
  dialog: {},
  shell: {},
  systemPreferences: {},
}))
beforeEach(() => {
  mocks.handlers.clear()
  mocks.listeners.clear()
  mocks.views.length = 0
  mocks.check = undefined
  mocks.fetch.mockReset()
  mocks.loadURL.mockReset().mockResolvedValue(undefined)
})
function setup() {
  const frame = { url: 'http://127.0.0.1:3181/' }
  const web = { mainFrame: frame, send: vi.fn(), focus: vi.fn() }
  const window = {
    webContents: web,
    isDestroyed: () => false,
    once: vi.fn(),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  }
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
  let workspace: BrowserWorkspace = { tabs: [], annotations: [] }
  registerBrowserRuntime({
    getWindow: () => window as never,
    origin: () => 'http://127.0.0.1:3181',
    rpc: async <T>(method: string, args?: unknown[]) => {
      if (method === 'browser:permission') snapshot.permissions = [args![0] as BrowserSnapshot['permissions'][number]]
      if (method === 'browser:workspace') return structuredClone(workspace) as T
      if (method === 'browser:save-workspace') {
        workspace = structuredClone(args![1] as BrowserWorkspace)
        return undefined as T
      }
      return structuredClone(snapshot) as T
    },
  })
  const event = { sender: web, senderFrame: frame }
  const call = (method: string, ...args: unknown[]) =>
    Promise.resolve(mocks.handlers.get('browser:call')!(event, method, args))
  return {
    event,
    call,
    web,
    frame,
    snapshot,
    workspace: () => workspace,
    setWorkspace: (value: BrowserWorkspace) => (workspace = value),
  }
}
function annotation(tabId: string, documentId: number): BrowserAnnotation {
  return {
    id: 'annotation-1',
    tabId,
    documentId,
    url: 'https://example.com/',
    title: '测试网页',
    capturedAt: new Date().toISOString(),
    kind: 'element',
    text: '内容',
    rect: { x: 20, y: 20, width: 80, height: 30 },
    viewport: { width: 400, height: 300, scale: 1, scrollX: 0, scrollY: 0 },
    comment: '原评论',
  }
}
describe('浏览器原生权限边界', () => {
  it('站点图标通过浏览器会话读取并转为可在应用中显示的图片', async () => {
    const f = setup()
    mocks.fetch.mockResolvedValue(new Response(new Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' })))
    await f.call('create', 'chat', 'tab', 'https://example.com/')
    const favicon = mocks.views[0].webContents.on.mock.calls.find(([name]) => name === 'page-favicon-updated')?.[1] as
      ((event: unknown, urls: string[]) => void) | undefined
    favicon?.({}, ['https://example.com/favicon.ico'])
    await vi.waitFor(() =>
      expect(f.web.send).toHaveBeenCalledWith(
        'browser:event',
        expect.objectContaining({
          type: 'tab',
          tab: expect.objectContaining({ favicon: 'data:image/png;base64,iVBORw==' }),
        }),
      ),
    )
  })
  it('拒绝外部页面、子框架和不匹配的窗口调用', async () => {
    const f = setup()
    const dispatch = mocks.handlers.get('browser:call')!
    await expect(Promise.resolve().then(() => dispatch({ ...f.event, sender: {} }, 'snapshot', []))).rejects.toThrow(
      '不允许',
    )
    await expect(
      Promise.resolve().then(() => dispatch({ ...f.event, senderFrame: { url: f.frame.url } }, 'snapshot', [])),
    ).rejects.toThrow('不允许')
    f.frame.url = 'https://example.com/'
    await expect(f.call('snapshot')).rejects.toThrow('不允许')
  })
  it('不允许跨聊天复用标签，关闭时释放原生视图', async () => {
    const f = setup()
    await f.call('create', 'chat-a', 'tab', 'https://example.com/')
    await expect(f.call('create', 'chat-b', 'tab')).rejects.toThrow('不属于')
    await f.call('close', 'tab')
    expect(mocks.views[0].webContents.close).toHaveBeenCalledOnce()
  })
  it('站点授权按来源隔离，撤销后查询立即拒绝', async () => {
    const f = setup()
    await f.call('create', 'chat', 'tab', 'https://example.com/')
    const web = mocks.views[0].webContents
    expect(mocks.check!(web, 'media', 'https://example.com')).toBe(false)
    await f.call('permission', { origin: 'https://example.com', permission: 'media', value: 'allow' })
    expect(mocks.check!(web, 'media', 'https://example.com')).toBe(true)
    expect(mocks.check!(web, 'media', 'https://other.example.com')).toBe(false)
    await f.call('permission', { origin: 'https://example.com', permission: 'media', value: 'deny' })
    expect(mocks.check!(web, 'media', 'https://example.com')).toBe(false)
  })
  it('拒绝未知操作、无效视图边界及过期浮层', async () => {
    const f = setup()
    await f.call('create', 'chat', 'tab', 'https://example.com/')
    await expect(f.call('arbitrary-script', 'alert(1)')).rejects.toThrow('未知')
    await expect(f.call('present', 'tab', { x: 0, y: 0, width: -1, height: 100 })).rejects.toThrow('边界')
    await expect(Promise.resolve().then(() => mocks.handlers.get('browser:overlay-state')!(f.event))).rejects.toThrow(
      '失效',
    )
  })
  it('批注工具条在界面就绪后才显示', async () => {
    const f = setup()
    await f.call('create', 'chat', 'tab', 'https://example.com/')
    await f.call('present', 'tab', { x: 0, y: 0, width: 400, height: 300 })
    await f.call('command', 'tab', { type: 'annotate', enabled: true })
    const toolbar = mocks.views[1]
    expect(toolbar.setVisible).toHaveBeenCalledWith(false)
    expect(toolbar.setVisible).not.toHaveBeenCalledWith(true)
    const event = { sender: toolbar.webContents, senderFrame: toolbar.webContents.mainFrame }
    await mocks.handlers.get('browser:overlay-action')!(event, { type: 'ready' })
    expect(toolbar.setVisible).toHaveBeenLastCalledWith(true)
  })
  it('编辑浮层加载期间取消选取不会使调用失败或恢复已取消的浮层', async () => {
    const f = setup()
    const tab = (await f.call('create', 'chat', 'tab', 'https://example.com/')) as { documentId: number }
    await f.call('present', 'tab', { x: 0, y: 0, width: 400, height: 300 })
    await f.call('command', 'tab', { type: 'annotate', enabled: true })
    const loading = Promise.withResolvers<void>()
    mocks.loadURL.mockReturnValueOnce(loading.promise)
    const restoring = f.call('command', 'tab', {
      type: 'restore-editor',
      annotation: annotation('tab', tab.documentId),
    })
    const result = expect(restoring).resolves.toBeUndefined()
    await vi.waitFor(() => expect(mocks.views).toHaveLength(3))
    const guest = { sender: mocks.views[0].webContents, senderFrame: mocks.views[0].webContents.mainFrame }
    mocks.listeners.get('browser:selection-cancel')!(guest)
    loading.reject(new Error("ERR_FAILED (-2) loading 'http://127.0.0.1:3181/?browser-overlay=editor'"))
    await result
    expect(mocks.views[2].webContents.close).toHaveBeenCalledOnce()
    expect(mocks.views).toHaveLength(3)
  })
  it('工具条加载期间退出批注不会重新打开编辑浮层', async () => {
    const f = setup()
    const tab = (await f.call('create', 'chat', 'tab', 'https://example.com/')) as { documentId: number }
    await f.call('present', 'tab', { x: 0, y: 0, width: 400, height: 300 })
    const loading = Promise.withResolvers<void>()
    mocks.loadURL.mockReturnValueOnce(loading.promise)
    const restoring = f.call('command', 'tab', {
      type: 'restore-editor',
      annotation: annotation('tab', tab.documentId),
    })
    const result = expect(restoring).resolves.toBeUndefined()
    await f.call('command', 'tab', { type: 'annotate', enabled: false })
    loading.reject(new Error('ERR_FAILED (-2)'))
    await result
    expect(mocks.views).toHaveLength(2)
  })
  it('浮层实际加载失败仍报错并允许再次打开', async () => {
    const f = setup()
    await f.call('create', 'chat', 'tab', 'https://example.com/')
    await f.call('present', 'tab', { x: 0, y: 0, width: 400, height: 300 })
    mocks.loadURL.mockRejectedValueOnce(new Error('ERR_CONNECTION_REFUSED'))
    await expect(f.call('command', 'tab', { type: 'annotate', enabled: true })).rejects.toThrow(
      'ERR_CONNECTION_REFUSED',
    )
    expect(mocks.views[1].webContents.close).toHaveBeenCalledOnce()
    await f.call('command', 'tab', { type: 'annotate', enabled: true })
    expect(mocks.views).toHaveLength(3)
  })
  it('取消选取后截图失败不会恢复已取消的草稿', async () => {
    const f = setup()
    const tab = (await f.call('create', 'chat', 'tab', 'https://example.com/')) as { documentId: number }
    await f.call('present', 'tab', { x: 0, y: 0, width: 400, height: 300 })
    await f.call('command', 'tab', { type: 'annotate', enabled: true })
    const web = mocks.views[0].webContents
    const capture = Promise.withResolvers<never>()
    web.capturePage.mockReturnValueOnce(capture.promise)
    const guest = { sender: web, senderFrame: web.mainFrame }
    mocks.listeners.get('browser:selected')!(guest, annotation('tab', tab.documentId))
    await vi.waitFor(() => expect(web.capturePage).toHaveBeenCalledOnce())
    mocks.listeners.get('browser:selection-cancel')!(guest)
    capture.reject(new Error('截图失败'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.views).toHaveLength(2)
    expect(f.web.send).toHaveBeenLastCalledWith('browser:event', { type: 'editor', owner: 'chat' })
  })
  it('菜单预览在视图隐藏后仍反映最新缩放', async () => {
    const f = setup()
    await f.call('create', 'chat', 'tab', 'https://example.com/')
    await f.call('present', 'tab', { x: 0, y: 0, width: 400, height: 300 })
    const web = mocks.views[0].webContents
    expect(await f.call('preview', 'tab')).toBe('data:image/png;base64,100')
    await f.call('present', 'tab', null, undefined, undefined, false)
    expect(web.capturePage).toHaveBeenCalledTimes(1)
    expect(web.setBackgroundThrottling).toHaveBeenLastCalledWith(false)
    await f.call('command', 'tab', { type: 'zoom', value: 1.4 })
    expect(await f.call('preview', 'tab')).toBe('data:image/png;base64,140')
    expect(web.executeJavaScript).toHaveBeenCalledOnce()
  })
  it('查找转发结果和方向，忽略旧请求及关闭后的结果', async () => {
    const f = setup()
    await f.call('create', 'chat', 'tab', 'https://example.com/')
    const web = mocks.views[0].webContents
    const found = web.on.mock.calls.find(([name]) => name === 'found-in-page')![1]
    await f.call('command', 'tab', { type: 'find', text: '苹果' })
    expect(web.findInPage).toHaveBeenLastCalledWith('苹果', { forward: true, findNext: true })
    found({}, { requestId: 1, activeMatchOrdinal: 1, matches: 3, finalUpdate: true })
    expect(f.web.send).toHaveBeenLastCalledWith('browser:event', {
      type: 'find-result',
      tabId: 'tab',
      text: '苹果',
      active: 1,
      matches: 3,
    })
    await f.call('command', 'tab', { type: 'find', text: '苹果', next: true, forward: false })
    expect(web.findInPage).toHaveBeenLastCalledWith('苹果', { forward: false, findNext: false })
    expect(web.stopFindInPage).toHaveBeenCalledTimes(1)
    f.web.send.mockClear()
    found({}, { requestId: 1, activeMatchOrdinal: 1, matches: 3, finalUpdate: true })
    expect(f.web.send).not.toHaveBeenCalled()
    await f.call('command', 'tab', { type: 'find', text: '' })
    found({}, { requestId: 2, activeMatchOrdinal: 3, matches: 3, finalUpdate: true })
    expect(f.web.send).not.toHaveBeenCalled()
    expect(web.stopFindInPage).toHaveBeenLastCalledWith('clearSelection')
  })
  it('网页内查找快捷键将焦点交给应用，并只处理当前可见网页', async () => {
    const f = setup()
    await f.call('create', 'chat', 'tab', 'https://example.com/')
    const web = mocks.views[0].webContents
    const input = web.on.mock.calls.find(([name]) => name === 'before-input-event')![1]
    const event = { preventDefault: vi.fn() }
    const key = {
      type: 'keyDown',
      key: 'f',
      meta: process.platform === 'darwin',
      control: process.platform !== 'darwin',
    }
    input(event, key)
    expect(event.preventDefault).not.toHaveBeenCalled()
    await f.call('present', 'tab', { x: 0, y: 0, width: 400, height: 300 })
    input(event, key)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(f.web.focus).toHaveBeenCalledOnce()
    expect(f.web.send).toHaveBeenLastCalledWith('browser:event', {
      type: 'browser-shortcut',
      tabId: 'tab',
      action: 'find',
    })
    input(event, { ...key, isComposing: true })
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
  it('点击当前文档标记后原位更新批注，拒绝过期标记', async () => {
    const f = setup()
    f.snapshot.settings.screenshots = 'none'
    const tab = (await f.call('create', 'chat', 'tab', 'https://example.com/')) as { documentId: number }
    await f.call('present', 'tab', { x: 0, y: 0, width: 400, height: 300 })
    await f.call('command', 'tab', { type: 'annotate', enabled: true })
    const saved = annotation('tab', tab.documentId)
    f.setWorkspace({ tabs: [], annotations: [saved] })
    await f.call('command', 'tab', { type: 'markers', annotations: [saved] })
    const guest = { sender: mocks.views[0].webContents, senderFrame: mocks.views[0].webContents.mainFrame }
    mocks.listeners.get('browser:marker-click')!(guest, 'unknown')
    expect(mocks.views).toHaveLength(2)
    mocks.listeners.get('browser:marker-click')!(guest, saved.id)
    expect(mocks.views).toHaveLength(3)
    const overlay = mocks.views[2].webContents
    const overlayEvent = { sender: overlay, senderFrame: overlay.mainFrame }
    await mocks.handlers.get('browser:overlay-action')!(overlayEvent, { type: 'comment', text: '修改后' })
    await mocks.handlers.get('browser:overlay-action')!(overlayEvent, { type: 'add' })
    expect(f.workspace().annotations).toEqual([{ ...saved, comment: '修改后', image: undefined }])
    expect(f.web.send).toHaveBeenCalledWith(
      'browser:event',
      expect.objectContaining({ type: 'annotation', owner: 'chat' }),
    )
    mocks.listeners.get('browser:marker-click')!(guest, 'missing')
    expect(mocks.views).toHaveLength(3)
  })
  it('页面左键取消未提交选取后关闭输入框并清除草稿', async () => {
    const f = setup()
    f.snapshot.settings.screenshots = 'none'
    const tab = (await f.call('create', 'chat', 'tab', 'https://example.com/')) as { documentId: number }
    await f.call('present', 'tab', { x: 0, y: 0, width: 400, height: 300 })
    await f.call('command', 'tab', { type: 'annotate', enabled: true })
    const guest = { sender: mocks.views[0].webContents, senderFrame: mocks.views[0].webContents.mainFrame }
    mocks.listeners.get('browser:selected')!(guest, annotation('tab', tab.documentId))
    await vi.waitFor(() => expect(mocks.views).toHaveLength(3))
    expect(mocks.views[0].webContents.send).toHaveBeenCalledWith(
      'browser:picker',
      expect.objectContaining({ editing: true }),
    )
    mocks.listeners.get('browser:selection-cancel')!(guest)
    expect(mocks.views[2].webContents.close).toHaveBeenCalledOnce()
    expect(mocks.views[0].webContents.send).toHaveBeenLastCalledWith('browser:picker', { reset: true })
    expect(f.web.send).toHaveBeenLastCalledWith('browser:event', { type: 'editor', owner: 'chat' })
  })
  it('评论换行时调整原生输入浮层高度并限制在网页视口内', async () => {
    const f = setup()
    const tab = (await f.call('create', 'chat', 'tab', 'https://example.com/')) as { documentId: number }
    await f.call('present', 'tab', { x: 10, y: 20, width: 400, height: 300 })
    await f.call('command', 'tab', { type: 'restore-editor', annotation: annotation('tab', tab.documentId) })
    const editor = mocks.views[2]
    const overlayEvent = { sender: editor.webContents, senderFrame: editor.webContents.mainFrame }
    await mocks.handlers.get('browser:overlay-action')!(overlayEvent, { type: 'resize-editor', height: 180 })
    expect(editor.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ height: 180 }))
    await mocks.handlers.get('browser:overlay-action')!(overlayEvent, { type: 'resize-editor', height: 500 })
    const bounds = editor.setBounds.mock.lastCall![0] as { y: number; height: number }
    expect(bounds.height).toBe(300)
    expect(bounds.y).toBeGreaterThanOrEqual(20)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(320)
  })
  it('底栏发送先保存未完成批注，再通知聊天发送', async () => {
    const f = setup()
    f.snapshot.settings.screenshots = 'none'
    const tab = (await f.call('create', 'chat', 'tab', 'https://example.com/')) as { documentId: number }
    await f.call('present', 'tab', { x: 0, y: 0, width: 400, height: 300 })
    const draft = annotation('tab', tab.documentId)
    await f.call('command', 'tab', { type: 'restore-editor', annotation: draft })
    const toolbar = mocks.views[1].webContents
    const toolbarEvent = { sender: toolbar, senderFrame: toolbar.mainFrame }
    await Promise.all([
      mocks.handlers.get('browser:overlay-action')!(toolbarEvent, { type: 'submit' }),
      mocks.handlers.get('browser:overlay-action')!(toolbarEvent, { type: 'submit' }),
    ])
    expect(f.workspace().annotations).toHaveLength(1)
    const events = f.web.send.mock.calls.flatMap(([channel, event]) =>
      channel === 'browser:event' ? [event.type] : [],
    )
    expect(events.indexOf('annotation')).toBeLessThan(events.indexOf('submit'))
    expect(events.filter((value) => value === 'submit')).toHaveLength(1)
  })
  it('工具条拖动限制在网页内，窄屏菜单展开时预留浮层高度', async () => {
    const f = setup()
    await f.call('create', 'chat', 'tab', 'https://example.com/')
    await f.call('present', 'tab', { x: 10, y: 20, width: 280, height: 300 })
    await f.call('command', 'tab', { type: 'annotate', enabled: true })
    expect(f.web.send).toHaveBeenCalledWith('browser:event', {
      type: 'annotation-mode',
      tabId: 'tab',
      enabled: true,
    })
    const toolbar = mocks.views[1]
    const event = { sender: toolbar.webContents, senderFrame: toolbar.webContents.mainFrame }
    await mocks.handlers.get('browser:overlay-action')!(event, { type: 'toolbar-menu', open: true })
    expect(toolbar.setBounds).toHaveBeenLastCalledWith({ x: 10, y: 102, width: 280, height: 210 })
    await mocks.handlers.get('browser:overlay-action')!(event, { type: 'move-toolbar', x: 9999, y: -9999 })
    const bounds = toolbar.setBounds.mock.lastCall![0] as { x: number; y: number; width: number; height: number }
    expect(bounds.x).toBe(10)
    expect(bounds.y).toBe(20)
    await f.call('command', 'tab', { type: 'annotate', enabled: false })
    expect(f.web.send).toHaveBeenCalledWith('browser:event', {
      type: 'annotation-mode',
      tabId: 'tab',
      enabled: false,
    })
  })
})
