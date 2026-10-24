import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { acquireDesktopHost } from '../src/main/local-host'

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  prepareEnv: vi.fn(),
  acquire: vi.fn(),
  storage: vi.fn(),
  pendingStorageJob: vi.fn(),
  app: {
    isPackaged: false,
    getPath: vi.fn(),
    setPath: vi.fn(),
    commandLine: { hasSwitch: vi.fn() },
    requestSingleInstanceLock: vi.fn(),
    on: vi.fn(),
    whenReady: vi.fn(),
    exit: vi.fn(),
  },
}))
vi.mock('electron', () => ({
  app: mocks.app,
  utilityProcess: { fork: mocks.fork },
  BrowserWindow: vi.fn(),
  dialog: {},
  ipcMain: {},
  shell: {},
  nativeImage: {},
  nativeTheme: {},
}))
vi.mock('../src/main/user-login-path', () => ({ prepareDesktopHostEnv: mocks.prepareEnv }))
vi.mock('@pi-meme/host/local-host', () => ({ acquireLocalHost: mocks.acquire }))
vi.mock('../src/main/storage/controller', () => ({ createStorageController: mocks.storage }))
vi.mock('../src/main/storage/preferences', () => ({ pendingStorageJob: mocks.pendingStorageJob }))
const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
beforeEach(() => {
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/fixture/resources' })
  mocks.app.isPackaged = false
  mocks.prepareEnv.mockImplementation(async (env: NodeJS.ProcessEnv) => ({ ...env }))
  mocks.acquire.mockImplementation(async ({ create }: { create: () => Promise<{ url: string }> }) => {
    const resource = await create()
    return { ownership: 'owned', url: resource.url, resource }
  })
})
afterEach(() => {
  if (resourcesPathDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor)
  else Reflect.deleteProperty(process, 'resourcesPath')
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.resetAllMocks()
})

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const child = Object.assign(new EventEmitter(), { stderr: null, postMessage: vi.fn(), kill: vi.fn() })
  child.postMessage.mockImplementation((value: { type: string; id?: string }) => {
    if (value.type === 'maintenance:prepare')
      queueMicrotask(() => child.emit('message', { type: 'maintenance:result', id: value.id }))
    if (value.type === 'stop') queueMicrotask(() => child.emit('exit', 0))
  })
  mocks.fork.mockImplementation((_entry, _args, options: { env: NodeJS.ProcessEnv }) => {
    queueMicrotask(() =>
      child.emit('message', { type: 'ready', url: `http://127.0.0.1:${options.env.PI_MEME_PORT}`, hostId: 'fixture' }),
    )
    return child
  })
  const lease = await acquireDesktopHost({ entry: '/fixture/host-process.js', env, dataRoot: '/fixture/data' })
  if (lease.ownership !== 'owned') throw new Error('fixture 应拥有 Host')
  return { child, process: lease.resource }
}

test.each([
  { packaged: false, override: undefined, port: '3180' },
  { packaged: true, override: undefined, port: '3185' },
  { packaged: false, override: '31417', port: '31417' },
  { packaged: true, override: '31417', port: '31417' },
  { packaged: false, override: '0', port: '0' },
  { packaged: true, override: '0', port: '0' },
])('Desktop packaged=$packaged、覆盖端口=$override 使用端口 $port', async ({ packaged, override, port }) => {
  mocks.app.isPackaged = packaged
  const f = await fixture({ PI_MEME_PORT: override })
  try {
    assert.equal(mocks.acquire.mock.calls[0][0].url, `http://127.0.0.1:${port}`)
    const env = mocks.fork.mock.calls[0][2].env
    assert.equal(env.PI_MEME_PORT, port)
    assert.equal(env.PI_MEME_PLUGIN_NODE, packaged ? '/fixture/resources/runtime/bin/node' : '')
    assert.equal(env.PI_MEME_PLUGIN_ENTRY, packaged ? '/fixture/resources/runtime/restricted-entry.mjs' : '')
  } finally {
    await f.process.dispose()
  }
})

test.each([
  { packaged: false, testCredentials: false, profile: undefined },
  { packaged: true, testCredentials: false, profile: undefined },
  { packaged: false, testCredentials: true, profile: undefined },
  { packaged: true, testCredentials: true, profile: undefined },
  { packaged: true, testCredentials: false, profile: 'custom-cache' },
])(
  'Desktop packaged=$packaged、测试凭据=$testCredentials、自定义目录=$profile 在申请单实例锁前隔离目录',
  async ({ packaged, testCredentials, profile }) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pi-desktop-profile-'))
    const appData = path.join(directory, 'application-support')
    const userData = path.join(appData, profile ?? 'Pi meme')
    const dataRoot = testCredentials ? path.join(directory, 'test-data') : undefined
    const expectedCache = dataRoot
      ? path.join(dataRoot, 'desktop-cache')
      : packaged
        ? profile
          ? userData
          : path.join(appData, 'pi-meme')
        : path.join(appData, 'pi-meme-dev')
    const paths = new Map([
      ['appData', appData],
      ['userData', userData],
    ])
    mocks.app.isPackaged = packaged
    mocks.app.commandLine.hasSwitch.mockImplementation((name: string) => name === 'user-data-dir' && Boolean(profile))
    mocks.app.getPath.mockImplementation((name: string) => paths.get(name))
    mocks.app.setPath.mockImplementation((name: string, value: string) => paths.set(name, value))
    mocks.app.requestSingleInstanceLock.mockImplementation(() => {
      assert.equal(paths.get('userData'), expectedCache)
      return true
    })
    mocks.app.whenReady.mockReturnValue(new Promise(() => {}))
    mocks.storage.mockReturnValue({})
    vi.stubEnv('PI_MEME_DATA_ROOT', dataRoot)
    vi.stubEnv('PI_MEME_TEST_CREDENTIALS', testCredentials ? 'memory' : undefined)
    try {
      vi.resetModules()
      await import('../src/main/main')
      assert.equal(mocks.app.requestSingleInstanceLock.mock.calls.length, 1)
      assert.equal(mocks.storage.mock.calls[0][0].anchor, expectedCache)
      assert.equal(mocks.storage.mock.calls[0][0].override, dataRoot)
      assert.equal(
        mocks.storage.mock.calls[0][0].defaultRoot ?? path.join(homedir(), '.pi-meme'),
        path.join(homedir(), packaged ? '.pi-meme' : '.pi-meme-dev'),
      )
      if (!testCredentials)
        assert.equal(mocks.pendingStorageJob.mock.calls[0][0], path.join(expectedCache, 'storage-location.json'))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test('启动 Host 前恢复 PATH，并保留 Host 参数与其他环境变量', async () => {
  const env = { PATH: '/usr/bin:/bin', ESBUILD_BINARY_PATH: '/fixture/esbuild', PI_MEME_PORT: '3180' }
  mocks.prepareEnv.mockImplementation(async (value: NodeJS.ProcessEnv) => {
    assert.equal(mocks.fork.mock.calls.length, 0)
    return { ...value, PATH: '/fixture/user-bin:/usr/bin:/bin' }
  })
  const f = await fixture(env)
  try {
    assert.equal(mocks.prepareEnv.mock.calls.length, 1)
    assert.deepEqual(mocks.fork.mock.calls[0][2].env, {
      ...env,
      PATH: '/fixture/user-bin:/usr/bin:/bin',
      PI_MEME_DATA_ROOT: '/fixture/data',
      PI_MEME_PLUGIN_NODE: '',
      PI_MEME_PLUGIN_ENTRY: '',
    })
    assert.equal(env.PATH, '/usr/bin:/bin')
  } finally {
    await f.process.dispose()
  }
})

test('连接已有 Host 不探测 Shell，也不创建进程', async () => {
  mocks.acquire.mockResolvedValue({ ownership: 'attached', url: 'http://127.0.0.1:3185' })
  const lease = await acquireDesktopHost({ entry: '/fixture/host-process.js', env: {}, dataRoot: '/fixture/data' })
  assert.equal(lease.ownership, 'attached')
  assert.equal(mocks.prepareEnv.mock.calls.length, 0)
  assert.equal(mocks.fork.mock.calls.length, 0)
})

test('拥有方通过私有通道维护和正常停机，重复释放不再发送停机', async () => {
  const f = await fixture()
  await f.process.prepareMaintenance()
  await f.process.stopForMaintenance()
  await f.process.dispose()
  await f.process.dispose()
  assert.equal(f.child.postMessage.mock.calls.filter(([value]) => value.type === 'stop').length, 1)
  assert.equal(f.child.kill.mock.calls.length, 0)
})

test('维护准备后 Host 非零退出，不能把已经退出误认为正常停机', async () => {
  const f = await fixture()
  await f.process.prepareMaintenance()
  f.child.emit('exit', 1)
  await assert.rejects(f.process.stopForMaintenance(), /未正常退出/)
  await f.process.dispose()
})

test('维护等待中崩溃会拒绝请求，维护停机超时不强制终止', async () => {
  const crashed = await fixture()
  const preparation = crashed.process.prepareMaintenance()
  crashed.child.emit('exit', 1)
  await assert.rejects(preparation, /已退出/)
  const f = await fixture()
  f.child.postMessage.mockImplementation(() => {})
  vi.useFakeTimers()
  const rejection = assert.rejects(f.process.stopForMaintenance(), /不会强制终止后迁移/)
  await vi.advanceTimersByTimeAsync(60000)
  await rejection
  assert.equal(f.child.kill.mock.calls.length, 0)
  f.child.emit('exit', 0)
  await f.process.dispose()
})
