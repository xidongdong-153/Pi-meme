import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, test, vi } from 'vitest'

const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getPath: vi.fn(() => '/fixture/application-support/pi-meme'),
    commandLine: { hasSwitch: vi.fn(() => true) },
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(),
    on: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
  },
  window: vi.fn(),
  acquire: vi.fn(),
  client: vi.fn(),
  frontend: vi.fn(),
  storage: vi.fn(),
}))

vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('@pi-meme/client/node-host-client', () => ({ createNodeHostClient: mocks.client }))
vi.mock('@pi-meme/host/host-status', () => ({ readLocalHostStatus: async () => ({ hostId: 'fixture' }) }))
vi.mock('@pi-meme/host/frontend-server', () => ({ startFrontendServer: mocks.frontend }))
vi.mock('../src/main/local-host', () => ({ acquireDesktopHost: mocks.acquire }))
vi.mock('../src/main/window/create-window', () => ({ createWindow: mocks.window }))
vi.mock('../src/main/dock-icon', () => ({ syncDockIcon: vi.fn() }))
vi.mock('../src/main/ipc/register', () => ({ registerPlatformIpc: vi.fn() }))
vi.mock('../src/main/browser/browser-runtime', () => ({ registerBrowserRuntime: vi.fn() }))
vi.mock('../src/main/storage/controller', () => ({ createStorageController: mocks.storage }))
vi.mock('../src/main/storage/preferences', () => ({ pendingStorageJob: () => false }))

afterEach(() => {
  if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath)
  else Reflect.deleteProperty(process, 'resourcesPath')
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetAllMocks()
})

async function fixture(ownership: 'owned' | 'attached' = 'owned') {
  vi.resetModules()
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/fixture/resources' })
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined)
  vi.stubEnv('PI_MEME_DATA_ROOT', undefined)
  vi.stubEnv('PI_MEME_TEST_CREDENTIALS', undefined)
  vi.stubEnv('PI_MEME_REMOTE_HOST', undefined)
  const events = new EventEmitter()
  const actions: string[] = []
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  let destroyed = false
  const closeState = { blocked: false, pending: false }
  const webContents = Object.assign(new EventEmitter(), { getURL: () => 'http://127.0.0.1:32000' })
  const window = Object.assign(new EventEmitter(), {
    loadURL: vi.fn(async () => {}),
    isDestroyed: () => destroyed,
    webContents,
    close: vi.fn(() => {
      if (closeState.blocked) webContents.emit('will-prevent-unload', {})
      else if (!closeState.pending) finishClose()
    }),
  })
  function finishClose() {
    destroyed = true
    actions.push('window')
    window.emit('closed')
  }
  const storage = { busy: false, root: '/fixture/data', initialize: vi.fn(async () => {}), adapter: {} }
  const disposeHost = vi.fn(async () => {
    actions.push('host')
    await pending
  })
  mocks.app.whenReady.mockResolvedValue(undefined)
  mocks.app.on.mockImplementation((event, listener) => events.on(event, listener))
  mocks.window.mockReturnValue(window)
  mocks.storage.mockReturnValue(storage)
  mocks.acquire.mockResolvedValue({
    ownership,
    status: { hostId: 'fixture' },
    url: 'http://127.0.0.1:31415',
    resource: { child: new EventEmitter(), dispose: disposeHost },
  })
  mocks.client.mockResolvedValue({ dispose: () => actions.push('client') })
  mocks.frontend.mockResolvedValue({
    url: 'http://127.0.0.1:32000',
    dispose: async () => {
      actions.push('frontend')
    },
  })
  await import('../src/main/main')
  await vi.waitFor(() => assert.equal(window.loadURL.mock.calls.length, 1))
  return { events, actions, finish, window, storage, disposeHost, closeState, finishClose }
}

test('退出时先关闭窗口，再释放客户端、界面代理和自有 Host，等待期间不重开窗口', async () => {
  const f = await fixture()
  try {
    assert.equal(mocks.frontend.mock.calls[0][0].port, 2159)
    const preventDefault = vi.fn()
    f.events.emit('before-quit', { preventDefault })
    assert.equal(preventDefault.mock.calls.length, 1)
    assert.equal(f.window.isDestroyed(), true, '停止服务之前关闭窗口，避免正常退出显示断连错误')
    await vi.waitFor(() => assert.equal(f.disposeHost.mock.calls.length, 1))
    assert.deepEqual(f.actions, ['window', 'client', 'frontend', 'host'])
    assert.equal(mocks.app.quit.mock.calls.length, 0)
    f.events.emit('activate')
    f.events.emit('before-quit', { preventDefault })
    assert.equal(mocks.window.mock.calls.length, 1)
    assert.equal(f.disposeHost.mock.calls.length, 1)
  } finally {
    f.finish()
    await vi.waitFor(() => assert.equal(mocks.app.quit.mock.calls.length, 1))
  }
})

test('存储维护中拒绝退出，保留窗口和服务', async () => {
  const f = await fixture()
  f.storage.busy = true
  const preventDefault = vi.fn()
  f.events.emit('before-quit', { preventDefault })
  assert.equal(preventDefault.mock.calls.length, 1)
  assert.equal(f.window.isDestroyed(), false)
  assert.deepEqual(f.actions, [])
  assert.equal(mocks.app.quit.mock.calls.length, 0)
})

test('未保存内容阻止窗口关闭时保留服务，再次退出只执行一次清理', async () => {
  const f = await fixture()
  try {
    f.closeState.blocked = true
    f.events.emit('before-quit', { preventDefault: vi.fn() })
    assert.equal(f.window.isDestroyed(), false)
    assert.deepEqual(f.actions, [])
    assert.equal(mocks.app.quit.mock.calls.length, 0)
    f.closeState.blocked = false
    f.events.emit('before-quit', { preventDefault: vi.fn() })
    await vi.waitFor(() => assert.equal(f.disposeHost.mock.calls.length, 1))
    assert.deepEqual(f.actions, ['window', 'client', 'frontend', 'host'])
  } finally {
    f.finish()
    await vi.waitFor(() => assert.equal(mocks.app.quit.mock.calls.length, 1))
  }
})

test('等待渲染进程确认关闭期间不释放连接或 Host', async () => {
  const f = await fixture()
  try {
    f.closeState.pending = true
    f.events.emit('before-quit', { preventDefault: vi.fn() })
    assert.equal(f.window.close.mock.calls.length, 1)
    assert.deepEqual(f.actions, [])
    f.finishClose()
    await vi.waitFor(() => assert.equal(f.disposeHost.mock.calls.length, 1))
  } finally {
    f.finish()
    await vi.waitFor(() => assert.equal(mocks.app.quit.mock.calls.length, 1))
  }
})

test('退出复用外部 Host 的 App 时只关闭窗口和本机客户端、代理', async () => {
  const f = await fixture('attached')
  f.events.emit('before-quit', { preventDefault: vi.fn() })
  await vi.waitFor(() => assert.equal(mocks.app.quit.mock.calls.length, 1))
  assert.deepEqual(f.actions, ['window', 'client', 'frontend'])
  assert.equal(f.disposeHost.mock.calls.length, 0)
})
