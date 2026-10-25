import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserSnapshot } from '@pi-meme/contracts/browser'
import { registerBrowserRuntime } from '../src/main/browser/browser-runtime'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  views: [] as Array<{
    webContents: { mainFrame: { url: string }; close: ReturnType<typeof vi.fn> }
    setVisible: ReturnType<typeof vi.fn>
  }>,
  check: undefined as undefined | ((web: unknown, permission: string, origin: string) => boolean),
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
    }),
  },
  BrowserWindow: class {
    static fromWebContents() {
      return null
    }
  },
  WebContentsView: class {
    webContents = {
      mainFrame: { url: '' },
      getURL: () => this.webContents.mainFrame.url,
      getTitle: () => '测试网页',
      isLoading: () => false,
      isDestroyed: () => false,
      close: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: async (url: string) => {
        this.webContents.mainFrame.url = url
      },
      send: vi.fn(),
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
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
})
function setup() {
  const frame = { url: 'http://127.0.0.1:3181/' }
  const web = { mainFrame: frame, send: vi.fn() }
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
  registerBrowserRuntime({
    getWindow: () => window as never,
    origin: () => 'http://127.0.0.1:3181',
    rpc: async <T>(method: string, args?: unknown[]) => {
      if (method === 'browser:permission') snapshot.permissions = [args![0] as BrowserSnapshot['permissions'][number]]
      return structuredClone(snapshot) as T
    },
  })
  const event = { sender: web, senderFrame: frame }
  const call = (method: string, ...args: unknown[]) =>
    Promise.resolve(mocks.handlers.get('browser:call')!(event, method, args))
  return { event, call, web, frame, snapshot }
}
describe('浏览器原生权限边界', () => {
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
})
