import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { registerPlatformIpc } from '../src/main/ipc/register'
import { recoveryUrl } from '../src/main/window/recovery-page'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  app: { on: () => {} },
  ipcMain: {
    handle: (channel: string, callback: (event: unknown, ...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, callback),
    removeHandler: () => {},
  },
  dialog: {},
  shell: { openPath: vi.fn() },
}))

let testDir = ''

beforeEach(async () => {
  vi.resetAllMocks()
  mocks.handlers.clear()
  testDir = await mkdtemp(path.join(tmpdir(), 'pi-meme-shortcuts-ipc-test-'))
})

afterEach(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true })
})

function setup(local = true) {
  const frame = { url: 'http://127.0.0.1:3000/' }
  const webContents = { mainFrame: frame }
  registerPlatformIpc(
    () => ({ webContents }) as never,
    async () => ({ hostId: 'fixture', url: frame.url, token: '', local }),
    () => 'http://127.0.0.1:3000',
    async () => {},
    async () => {},
    { list: async () => [], remove: async () => {}, error: () => null },
    undefined,
    testDir,
  )
  return { frame, webContents, event: { sender: webContents, senderFrame: frame } }
}

test('IPC handlers 正常读写快捷键设置', async () => {
  const f = setup()
  const read = mocks.handlers.get('platform:shortcuts-read')!
  const save = mocks.handlers.get('platform:shortcuts-save')!

  const initial = await read(f.event)
  assert.deepEqual(initial, { version: 1, overrides: {} })

  const next = { version: 1, overrides: { newChat: 'Mod+Shift+N' } }
  await save(f.event, next)

  const updated = await read(f.event)
  assert.deepEqual(updated, next)
})

test('IPC 拒绝不可信来源调用', async () => {
  const f = setup()
  const read = mocks.handlers.get('platform:shortcuts-read')!
  for (const url of ['https://remote.example', recoveryUrl]) {
    f.frame.url = url
    assert.throws(() => read(f.event), /不允许/)
  }
})
