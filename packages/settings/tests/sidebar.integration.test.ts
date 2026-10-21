import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SettingsStore } from '../src/server/store'
import { createSettingsHandlers } from '../src/server/handlers'
import { defaultSidebarPreferences, parseSidebarPreferencesPatch } from '../src/shared/sidebar'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'

test('旧设置读取补全侧栏默认值，不改写文件', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-sidebar-settings-'))
  try {
    const file = path.join(directory, storageLayoutRelativePaths.appConfigFile)
    await mkdir(path.dirname(file), { recursive: true })
    const original = JSON.stringify({ themeId: 'dark', preferredProjectApp: 'cursor', pinnedPaths: ['项目'] })
    await writeFile(file, original)
    const store = new SettingsStore(directory)
    assert.deepEqual((await store.load()).settings.sidebar, defaultSidebarPreferences())
    assert.equal(await readFile(file, 'utf8'), original)
    const stale = store.snapshot().settings
    await Promise.all([
      store.saveSidebarPreferences({ groupMode: 'merged', collapsed: { pinned: true }, orders: { pinned: ['a'] } }),
      store.saveSidebarPreferences({ sortMode: 'manual', collapsed: { recents: true }, orders: { projects: ['b'] } }),
      store.save({ ...stale, preferredProjectApp: 'zed' }),
      store.togglePin('另一个项目'),
    ])
    const expected = {
      groupMode: 'merged',
      sortMode: 'manual',
      collapsed: { pinned: true, projects: false, recents: true },
      orders: { pinned: ['a'], projects: ['b'] },
    }
    assert.deepEqual(store.settings.sidebar, expected)
    assert.equal(store.settings.preferredProjectApp, 'zed')
    assert.deepEqual(store.settings.pinnedPaths, ['项目', '另一个项目'])
    const restored = new SettingsStore(directory)
    assert.deepEqual((await restored.load()).settings.sidebar, expected)
    await mkdir(`${file}.tmp`)
    await assert.rejects(store.saveSidebarPreferences({ groupMode: 'projects' }))
    assert.deepEqual(store.settings.sidebar, expected)
    await rm(`${file}.tmp`, { recursive: true })
    await store.saveSidebarPreferences({ groupMode: 'projects' })
    assert.equal(JSON.parse(await readFile(file, 'utf8')).sidebar.groupMode, 'projects')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('项目和置顶拖拽顺序重读后保留，不改变聊天最近更新模式', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-sidebar-orders-'))
  try {
    const store = new SettingsStore(directory)
    await store.load()
    await store.saveSidebarPreferences({ orders: { projects: ['a', 'b'], pinned: ['x', 'y'] } })
    await store.saveSidebarPreferences({ orders: { projects: ['b', 'a'] } })
    await store.saveSidebarPreferences({ orders: { pinned: ['y', 'x'] } })
    const restored = new SettingsStore(directory)
    const sidebar = (await restored.load()).settings.sidebar
    assert.ok(sidebar)
    assert.equal(sidebar.sortMode, 'recent')
    assert.deepEqual(sidebar.orders, { projects: ['b', 'a'], pinned: ['y', 'x'] })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('侧栏补丁拒绝无效类型、未知字段和重复排序项', () => {
  for (const value of [
    null,
    [],
    { groupMode: 'unknown' },
    { sortMode: 'unknown' },
    { collapsed: { pinned: 1 } },
    { collapsed: { extra: true } },
    { orders: { pinned: ['a', 'a'] } },
    { orders: { pinned: [1] } },
    { orders: [] },
    { extra: true },
  ])
    assert.throws(() => parseSidebarPreferencesPatch(value), /侧栏/)
})

test('侧栏 RPC 保存不等待 Pi 空闲，也不触发重连', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-sidebar-rpc-'))
  try {
    const settings = new SettingsStore(directory)
    await settings.load()
    const handlers = createSettingsHandlers({
      settings,
      pi: {
        idle: () => assert.fail('侧栏保存不得等待空闲'),
        reconnectModels: () => assert.fail('侧栏保存不得重连'),
      } as never,
    })
    assert.equal((await handlers['settings:sidebar']({ sortMode: 'manual' })).sortMode, 'manual')
    await assert.rejects(handlers['settings:sidebar']({ sortMode: '错误' }), /侧栏/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
