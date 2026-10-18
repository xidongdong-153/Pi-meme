import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { acquireDesktopHost } from '../src/main/local-host'

const mocks = vi.hoisted(() => ({ fork: vi.fn(), prepareEnv: vi.fn(), acquire: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: mocks.fork } }))
vi.mock('../src/main/user-login-path', () => ({ prepareDesktopHostEnv: mocks.prepareEnv }))
vi.mock('@pi-meme/host/local-host', () => ({ acquireLocalHost: mocks.acquire }))
beforeEach(() => {
  mocks.prepareEnv.mockImplementation(async (env: NodeJS.ProcessEnv) => ({ ...env }))
  mocks.acquire.mockImplementation(async ({ create }: { create: () => Promise<{ url: string }> }) => {
    const resource = await create()
    return { ownership: 'owned', url: resource.url, resource }
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const child = Object.assign(new EventEmitter(), { stderr: null, postMessage: vi.fn(), kill: vi.fn() })
  child.postMessage.mockImplementation((value: { type: string; id?: string }) => {
    if (value.type === 'maintenance:prepare')
      queueMicrotask(() => child.emit('message', { type: 'maintenance:result', id: value.id }))
    if (value.type === 'stop') queueMicrotask(() => child.emit('exit', 0))
  })
  mocks.fork.mockImplementation(() => {
    queueMicrotask(() => child.emit('message', { type: 'ready', url: 'http://127.0.0.1:31415', hostId: 'fixture' }))
    return child
  })
  const lease = await acquireDesktopHost({ entry: '/fixture/host-process.js', env, dataRoot: '/fixture/data' })
  if (lease.ownership !== 'owned') throw new Error('fixture 应拥有 Host')
  return { child, process: lease.resource }
}

test('启动 Host 前恢复 PATH，并保留 Host 参数与其他环境变量', async () => {
  const env = { PATH: '/usr/bin:/bin', ESBUILD_BINARY_PATH: '/fixture/esbuild', PI_MEME_PORT: '31416' }
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
    })
    assert.equal(env.PATH, '/usr/bin:/bin')
  } finally {
    await f.process.dispose()
  }
})

test('连接已有 Host 不探测 Shell，也不创建进程', async () => {
  mocks.acquire.mockResolvedValue({ ownership: 'attached', url: 'http://127.0.0.1:31415' })
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
