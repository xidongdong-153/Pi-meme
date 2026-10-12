import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SidebarPreferences, SidebarPreferencesPatch } from '@pi-meme/contracts/settings'
import type { PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import { buildSidebarModel, sidebarItemKey, sidebarManualOrders } from '../src/ui/sidebar/sidebar-model'
import { sidebarManualOrdersPatch, SidebarPreferencesSaver } from '../src/ui/sidebar/use-sidebar-preferences'

function defaults(): SidebarPreferences {
  return {
    groupMode: 'projects',
    sortMode: 'recent',
    collapsed: { pinned: false, projects: false, recents: false },
    orders: {},
  }
}

test('侧栏乐观修改按顺序保存，旧响应不覆盖后续修改', async () => {
  const calls: SidebarPreferencesPatch[] = []
  let finish!: (value: SidebarPreferences) => void
  let latest = defaults()
  const saver = new SidebarPreferencesSaver(
    defaults(),
    async (patch) => {
      calls.push(patch)
      if (calls.length === 1)
        return new Promise((resolve) => {
          finish = resolve
        })
      return { ...defaults(), groupMode: 'merged', sortMode: 'manual' }
    },
    (value) => {
      latest = value
    },
    (error) => assert.equal(error, ''),
  )
  const first = saver.save({ groupMode: 'merged' })
  const second = saver.save({ sortMode: 'manual' })
  assert.equal(latest.groupMode, 'merged')
  assert.equal(latest.sortMode, 'manual')
  await Promise.resolve()
  assert.equal(calls.length, 1)
  finish({ ...defaults(), groupMode: 'merged' })
  await first
  assert.equal(latest.sortMode, 'manual')
  await second
  assert.deepEqual(calls, [{ groupMode: 'merged' }, { sortMode: 'manual' }])
})

test('保存失败回滚已确认值并保留后续修改，卸载后不更新界面', async () => {
  let reject!: (cause: Error) => void
  let latest = defaults()
  const errors: string[] = []
  let updates = 0
  const saver = new SidebarPreferencesSaver(
    defaults(),
    async (patch) => {
      if (patch.groupMode)
        return new Promise((_, fail) => {
          reject = fail
        })
      return { ...defaults(), collapsed: { ...defaults().collapsed, recents: true } }
    },
    (value) => {
      latest = value
      updates += 1
    },
    (error) => errors.push(error),
  )
  const first = saver.save({ groupMode: 'merged' })
  const second = saver.save({ collapsed: { recents: true } })
  await Promise.resolve()
  reject(new Error('磁盘不可写'))
  await first
  assert.equal(latest.groupMode, 'projects')
  assert.equal(latest.collapsed.recents, true)
  await second
  assert.match(errors.join(''), /侧栏设置保存失败.*磁盘不可写/)
  const failed = saver.save({ groupMode: 'merged' })
  await Promise.resolve()
  reject(new Error('磁盘不可写'))
  await failed
  assert.equal(latest.groupMode, 'projects')
  const pending = saver.save({ groupMode: 'merged' })
  await Promise.resolve()
  saver.dispose()
  const previous = updates
  reject(new Error('磁盘不可写'))
  await pending
  assert.equal(updates, previous)
})

test('偏好读取未完成时保留操作，读取响应与保存结果都不盖掉后续修改', async () => {
  let resolve!: (value: SidebarPreferences) => void
  const initial = new Promise<SidebarPreferences>((finish) => {
    resolve = finish
  })
  let latest = defaults()
  let stored: SidebarPreferences = { ...defaults(), sortMode: 'manual' }
  const calls: SidebarPreferencesPatch[] = []
  const saver = new SidebarPreferencesSaver(
    defaults(),
    async (patch) => {
      calls.push(patch)
      stored = {
        ...stored,
        ...patch,
        collapsed: { ...stored.collapsed, ...patch.collapsed },
        orders: { ...stored.orders, ...patch.orders },
      }
      return stored
    },
    (value) => {
      latest = value
    },
    (error) => assert.equal(error, ''),
    initial,
  )
  const saving = saver.save({ collapsed: { recents: true } })
  assert.equal(latest.collapsed.recents, true)
  await Promise.resolve()
  assert.equal(calls.length, 0)
  resolve(stored)
  await saving
  assert.equal(latest.sortMode, 'manual')
  assert.equal(latest.collapsed.recents, true)
  assert.equal(calls.length, 1)
})

test('读取偏好失败仍继续保存已做修改，并显示读取错误', async () => {
  let latest = defaults()
  const errors: string[] = []
  const saver = new SidebarPreferencesSaver(
    defaults(),
    async (patch) => ({ ...defaults(), ...patch, collapsed: { ...defaults().collapsed, ...patch.collapsed } }),
    (value) => {
      latest = value
    },
    (error) => errors.push(error),
    Promise.reject(new Error('连接中断')),
  )
  await saver.save({ groupMode: 'merged' })
  assert.equal(latest.groupMode, 'merged')
  assert.match(errors.join(''), /侧栏设置读取失败.*连接中断/)
})

function manualSource(): PiSessionsSnapshot {
  return {
    projects: [],
    pinnedPaths: [],
    recents: [
      {
        id: 'first',
        path: '/first',
        cwd: '/',
        created: '2026-01-01',
        modified: '2026-01-01',
        messageCount: 0,
        workspaceKind: 'standalone',
      },
    ],
  }
}

test('自动追加只在读取完成且手动排序时保存变化列表，不覆盖已保存快照', () => {
  const source = manualSource()
  const sources = [{ serviceId: 'a', snapshot: source }]
  const preferences = { ...defaults(), sortMode: 'manual' as const }
  preferences.orders = sidebarManualOrders(buildSidebarModel(sources, preferences), {})
  const original = structuredClone(preferences.orders)
  source.recents.push({ ...source.recents[0], id: 'second', path: '/second', created: '2026-02-01' })
  const model = buildSidebarModel(sources, preferences)
  const attempted = new Map<string, string>()
  assert.equal(sidebarManualOrdersPatch(model, preferences, false, attempted), undefined)
  assert.equal(attempted.size, 0)
  assert.equal(sidebarManualOrdersPatch(model, { ...preferences, sortMode: 'recent' }, true, attempted), undefined)
  assert.equal(attempted.size, 0)
  const patch = sidebarManualOrdersPatch(model, preferences, true, attempted)
  assert.deepEqual(patch, { orders: { recents: [...original.recents, sidebarItemKey('a', 'session', '/second')] } })
  assert.deepEqual(preferences.orders, original)
  assert.equal(
    sidebarManualOrdersPatch(model, { ...preferences, orders: { ...original, ...patch?.orders } }, true, attempted),
    undefined,
  )
  assert.equal(sidebarManualOrdersPatch(model, preferences, true, attempted), undefined)
})

test('自动追加保存失败后保留回滚值且不无限重试，之后新增项仍可保存', async () => {
  const source = manualSource()
  const sources = [{ serviceId: 'a', snapshot: source }]
  let latest = { ...defaults(), sortMode: 'manual' as const } as SidebarPreferences
  latest.orders = sidebarManualOrders(buildSidebarModel(sources, latest), {})
  const original = structuredClone(latest)
  let calls = 0
  const errors: string[] = []
  const saver = new SidebarPreferencesSaver(
    latest,
    async (patch) => {
      calls += 1
      if (calls === 1) throw new Error('磁盘不可写')
      return { ...latest, orders: { ...latest.orders, ...patch.orders } }
    },
    (value) => {
      latest = value
    },
    (error) => errors.push(error),
  )
  const attempted = new Map<string, string>()
  source.recents.push({ ...source.recents[0], id: 'second', path: '/second', created: '2026-02-01' })
  const patch = sidebarManualOrdersPatch(buildSidebarModel(sources, latest), latest, true, attempted)!
  await saver.save(patch)
  assert.deepEqual(latest, original)
  assert.match(errors.join(''), /侧栏设置保存失败.*磁盘不可写/)
  for (let index = 0; index < 3; index += 1)
    assert.equal(sidebarManualOrdersPatch(buildSidebarModel(sources, latest), latest, true, attempted), undefined)
  assert.equal(calls, 1)
  source.recents.push({ ...source.recents[0], id: 'third', path: '/third', created: '2026-03-01' })
  const nextPatch = sidebarManualOrdersPatch(buildSidebarModel(sources, latest), latest, true, attempted)!
  await saver.save(nextPatch)
  assert.equal(calls, 2)
  assert.deepEqual(latest.orders.recents, [
    original.orders.recents[0],
    sidebarItemKey('a', 'session', '/third'),
    sidebarItemKey('a', 'session', '/second'),
  ])
})
