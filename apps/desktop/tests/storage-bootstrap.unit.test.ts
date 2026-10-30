import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStorageController } from '../src/main/storage/controller'
import { previewMigration } from '@pi-meme/host/storage/migrate'
import type { StorageProcessRequest } from '../src/main/storage/task'
import { pendingStorageJob, readStoragePreferences, writeStoragePreferences } from '../src/main/storage/preferences'

const mocks = vi.hoisted(() => ({
  choose: vi.fn(),
  process: vi.fn(),
  relaunch: vi.fn(),
  exit: vi.fn(),
  openPath: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { relaunch: mocks.relaunch, exit: mocks.exit },
  dialog: { showOpenDialog: mocks.choose },
  shell: { openPath: mocks.openPath },
  BrowserWindow: class {},
}))
vi.mock('../src/main/storage/process', () => ({ runStorageProcess: mocks.process }))
afterEach(() => {
  vi.resetAllMocks()
})
async function fixture(override?: string, ownsHost = () => true) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-meme-storage-bootstrap-')))
  const anchor = path.join(directory, 'desktop')
  const defaultRoot = path.join(directory, 'default')
  const target = path.join(directory, 'target')
  await Promise.all([anchor, defaultRoot, target].map((value) => mkdir(value)))
  const stopHost = vi.fn(async () => {})
  const controller = createStorageController({
    anchor,
    defaultRoot,
    override,
    getWindow: () => ({}) as never,
    getHostId: () => 'fixture-host',
    ownsHost,
    stopHost,
  })
  mocks.process.mockResolvedValue(12)
  return {
    directory,
    anchor,
    defaultRoot,
    target,
    stopHost,
    controller,
    file: path.join(anchor, 'storage-location.json'),
    dispose: () => rm(directory, { recursive: true, force: true }),
  }
}

test('环境变量、自定义目录和默认目录按优先级解析，环境变量模式只读', async () => {
  const f = await fixture('/external-profile')
  try {
    await writeStoragePreferences(f.file, { version: 1, dataRoot: f.target, backupPaths: [] })
    await f.controller.initialize()
    assert.equal(f.controller.root, '/external-profile')
    assert.equal((await f.controller.adapter.getInfo('fixture-host')).source, 'environment')
    await assert.rejects(f.controller.adapter.chooseTarget('fixture-host'), /PI_MEME_DATA_ROOT/)
    await assert.rejects(f.controller.adapter.clearCache('fixture-host'), /PI_MEME_DATA_ROOT/)
    assert.equal(mocks.choose.mock.calls.length, 0)
    const normal = createStorageController({
      anchor: f.anchor,
      defaultRoot: f.defaultRoot,
      getWindow: () => null,
      getHostId: () => 'fixture-host',
      ownsHost: () => true,
      stopHost: f.stopHost,
    })
    await normal.initialize()
    assert.equal(normal.root, f.target)
    await rm(f.file)
    await normal.initialize()
    assert.equal(normal.root, f.defaultRoot)
  } finally {
    await f.dispose()
  }
})

test('损坏或不可用的自定义目录停止启动，不回退创建空目录', async () => {
  const f = await fixture()
  try {
    for (const invalid of ['null', '{', '{"version":1,"backupPaths":[],"dataRoot":"relative"}']) {
      await writeFile(f.file, invalid)
      await assert.rejects(f.controller.initialize())
      assert.equal(await readFile(f.file, 'utf8'), invalid)
    }
    await writeStoragePreferences(f.file, { version: 1, dataRoot: path.join(f.directory, 'missing'), backupPaths: [] })
    await assert.rejects(f.controller.initialize(), /不可用/)
  } finally {
    await f.dispose()
  }
})

test('迁移目标由主进程签发，错误 Host 和过期选择不能触发维护', async () => {
  const f = await fixture()
  try {
    await f.controller.initialize()
    await assert.rejects(f.controller.adapter.getInfo('remote-host'), /本机服务/)
    await assert.rejects(f.controller.adapter.clearCache('remote-host'), /本机服务/)
    await assert.rejects(
      f.controller.adapter.migrate({ expectedHostId: 'fixture-host', selectionId: 'forged' }),
      /目录选择器/,
    )
    mocks.choose.mockResolvedValue({ canceled: false, filePaths: [f.target] })
    mocks.process.mockResolvedValue({ path: f.target, bytes: 1, availableBytes: 1024 })
    const chosen = await f.controller.adapter.chooseTarget('fixture-host')
    assert.equal(chosen?.path, f.target)
    await assert.rejects(
      f.controller.adapter.migrate({ expectedHostId: 'fixture-host', selectionId: 'forged' }),
      /目录选择器/,
    )
    await f.controller.adapter.migrate({ expectedHostId: 'fixture-host', selectionId: chosen!.selectionId })
    assert.equal(f.stopHost.mock.calls.length, 1)
    assert.equal(mocks.relaunch.mock.calls.length, 1)
    const saved = await readStoragePreferences(f.file)
    assert.equal(saved.pending?.target, f.target)
    assert.equal(saved.dataRoot, f.defaultRoot)
    assert.equal(pendingStorageJob(f.file)?.id, saved.pending?.id)
    await assert.rejects(
      f.controller.adapter.migrate({ expectedHostId: 'fixture-host', selectionId: chosen!.selectionId }),
      /维护任务/,
    )
  } finally {
    await f.dispose()
  }
})

test('Host 停机失败不安排任务，也不重启或清理', async () => {
  const f = await fixture()
  try {
    await f.controller.initialize()
    f.stopHost.mockRejectedValue(new Error('停机超时'))
    await assert.rejects(f.controller.adapter.clearCache('fixture-host'), /停机超时/)
    const saved = await readStoragePreferences(f.file)
    assert.equal(saved.pending, undefined)
    assert.equal(saved.lastError, '停机超时')
    assert.equal(mocks.relaunch.mock.calls.length, 0)
    assert.equal(mocks.process.mock.calls.length, 0)
  } finally {
    await f.dispose()
  }
})

test('目录选择器返回链接时不提前解析成真实路径绕过预检', async () => {
  const f = await fixture()
  try {
    await f.controller.initialize()
    const linked = path.join(f.directory, 'linked')
    await symlink(f.target, linked)
    mocks.choose.mockResolvedValue({ canceled: false, filePaths: [linked] })
    mocks.process.mockImplementation((request: StorageProcessRequest) =>
      request.type === 'preview' ? previewMigration(request.root, request.target, request.anchor) : Promise.resolve(0),
    )
    await assert.rejects(f.controller.adapter.chooseTarget('fixture-host'), /符号链接/)
    assert.equal(f.stopHost.mock.calls.length, 0)
  } finally {
    await f.dispose()
  }
})

test('缓存统计失败返回未知占用，打开目录仅允许当前目录和备份', async () => {
  const f = await fixture()
  try {
    await f.controller.initialize()
    mocks.process.mockRejectedValue(new Error('无法读取缓存'))
    const info = await f.controller.adapter.getInfo('fixture-host')
    assert.equal(info.cacheBytes, null)
    assert.equal(info.cacheError, '无法读取缓存')
    await assert.rejects(
      f.controller.adapter.openDirectory({ expectedHostId: 'fixture-host', path: f.directory }),
      /只能打开/,
    )
    mocks.openPath.mockResolvedValue('')
    await f.controller.adapter.openDirectory({ expectedHostId: 'fixture-host', path: f.defaultRoot })
    assert.equal(mocks.openPath.mock.calls.length, 1)
  } finally {
    await f.dispose()
  }
})

test('复用的 Host 允许查看与打开目录，禁止维护；选择后失去所有权也不能迁移', async () => {
  let owned = false
  const f = await fixture(undefined, () => owned)
  try {
    await f.controller.initialize()
    const info = await f.controller.adapter.getInfo('fixture-host')
    assert.equal(info.canMaintain, false)
    assert.match(info.maintenanceDisabledReason!, /其他入口管理/)
    await assert.rejects(f.controller.adapter.chooseTarget('fixture-host'), /其他入口管理/)
    await assert.rejects(f.controller.adapter.clearCache('fixture-host'), /其他入口管理/)
    assert.equal(mocks.choose.mock.calls.length, 0)
    mocks.openPath.mockResolvedValue('')
    await f.controller.adapter.openDirectory({ expectedHostId: 'fixture-host', path: f.defaultRoot })
    owned = true
    mocks.choose.mockResolvedValue({ canceled: false, filePaths: [f.target] })
    mocks.process.mockResolvedValue({ path: f.target, bytes: 1, availableBytes: 1024 })
    const chosen = await f.controller.adapter.chooseTarget('fixture-host')
    owned = false
    await assert.rejects(
      f.controller.adapter.migrate({ expectedHostId: 'fixture-host', selectionId: chosen!.selectionId }),
      /其他入口管理/,
    )
    assert.equal(f.stopHost.mock.calls.length, 0)
    assert.equal(mocks.relaunch.mock.calls.length, 0)
  } finally {
    await f.dispose()
  }
})
