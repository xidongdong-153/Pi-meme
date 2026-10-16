import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'
import type { DesktopStorageAdapter } from '@pi-meme/contracts/storage'
import { registerPlatformIpc } from '../src/main/ipc/register'
import { recoveryUrl } from '../src/main/window/recovery-page'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  app: { on: () => {} },
  ipcMain: {
    handle: (channel: string, callback: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, callback),
    removeHandler: () => {},
  },
  dialog: {},
  shell: {},
}))
beforeEach(() => handlers.clear())
function setup() {
  const frame = { url: 'http://127.0.0.1:3000/' }
  const webContents = { mainFrame: frame }
  const storage: DesktopStorageAdapter = {
    getInfo: vi.fn(),
    chooseTarget: vi.fn(),
    migrate: vi.fn(),
    clearCache: vi.fn(),
    openDirectory: vi.fn(),
  }
  registerPlatformIpc(
    () => ({ webContents }) as never,
    async () => ({ hostId: 'fixture', url: frame.url, token: '', local: true }),
    () => 'http://127.0.0.1:3000',
    async () => {},
    async () => {},
    { list: async () => [], remove: async () => {}, error: () => null },
    storage,
  )
  return { storage, frame, webContents, event: { sender: webContents, senderFrame: frame } }
}

test('只有可信主窗口的主 Frame 能调用本机存储 IPC', () => {
  const f = setup()
  const invoke = handlers.get('platform:storage-cache')!
  for (const event of [
    { sender: {}, senderFrame: f.frame },
    { sender: f.webContents, senderFrame: { url: f.frame.url } },
  ])
    assert.throws(() => invoke(event, 'fixture'), /不允许/)
  for (const url of ['https://remote.example', 'file:///tmp/test.html', recoveryUrl]) {
    f.frame.url = url
    assert.throws(() => invoke(f.event, 'fixture'), /不允许/)
  }
  assert.equal(vi.mocked(f.storage.clearCache).mock.calls.length, 0)
  f.frame.url = 'http://127.0.0.1:3000/settings'
  invoke(f.event, 'fixture')
  assert.deepEqual(vi.mocked(f.storage.clearCache).mock.calls, [['fixture']])
})

test('迁移和打开目录的 IPC 严格检查参数，不把未知对象交给执行器', () => {
  const f = setup()
  const migrate = handlers.get('platform:storage-migrate')!
  for (const input of [
    null,
    {},
    { expectedHostId: 'fixture', path: '/arbitrary' },
    { expectedHostId: {}, selectionId: 'forged' },
  ])
    assert.throws(() => migrate(f.event, input), /参数无效/)
  assert.equal(vi.mocked(f.storage.migrate).mock.calls.length, 0)
  migrate(f.event, { expectedHostId: 'fixture', selectionId: 'chosen', path: '/ignored' })
  assert.deepEqual(vi.mocked(f.storage.migrate).mock.calls, [[{ expectedHostId: 'fixture', selectionId: 'chosen' }]])
  assert.throws(
    () => handlers.get('platform:storage-open')!(f.event, { expectedHostId: 'fixture', path: 123 }),
    /参数无效/,
  )
})
