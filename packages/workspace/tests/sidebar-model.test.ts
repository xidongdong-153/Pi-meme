import assert from 'node:assert/strict'
import test from 'node:test'
import type { PiSessionSummary, PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import type { SidebarPreferences } from '@pi-meme/contracts/settings'
import {
  buildSidebarModel,
  reorderSidebarItems,
  searchSidebarSessions,
  sidebarItemKey,
  sidebarManualOrders,
} from '../src/ui/sidebar/sidebar-model'

const preferences: SidebarPreferences = {
  groupMode: 'projects',
  sortMode: 'recent',
  collapsed: { pinned: false, projects: false, recents: false },
  orders: {},
}
function session(path: string, created: string, extra: Partial<PiSessionSummary> = {}): PiSessionSummary {
  return { id: path, path, cwd: '/project', messageCount: 1, created, modified: created, firstMessage: path, ...extra }
}
const older = session('/older', '2026-01-01', { completedAt: '2026-04-01' })
const newer = session('/newer', '2026-03-01')
const standalone = session('/standalone', '2026-02-01', { workspaceKind: 'standalone' })
function snapshot(pinnedPaths: string[] = []): PiSessionsSnapshot {
  return {
    projects: [
      { cwd: '/project', name: '项目', sessionCount: 2, lastModified: '2026-01-01', sessions: [newer, older] },
    ],
    standaloneSessions: [standalone],
    recents: [older, newer, standalone],
    pinnedPaths,
  }
}
test('按来源与路径去重，置顶聊天从项目移出但保留真实计数', () => {
  const model = buildSidebarModel([{ serviceId: 'local', snapshot: snapshot(['/newer']) }], preferences)
  assert.equal(model.sessions.length, 3)
  assert.equal(model.projects[0].project.sessionCount, 2)
  assert.deepEqual(
    model.projects[0].project.sessions.map((item) => item.path),
    ['/older'],
  )
  assert.deepEqual(
    model.recents.map((item) => item.session.path),
    ['/standalone'],
  )
  assert.equal(model.pinned[0].key, sidebarItemKey('local', 'session', '/newer'))
})
test('跨 Host 的相同路径互不冲突，置顶按加入顺序并允许混合排序', () => {
  const sources = [
    { serviceId: 'a', snapshot: snapshot(['/newer', '/project']) },
    { serviceId: 'b', snapshot: snapshot(['/project', '/newer']) },
  ]
  const model = buildSidebarModel(sources, preferences)
  assert.equal(model.sessions.length, 6)
  assert.deepEqual(
    model.pinned.map((item) => item.kind),
    ['session', 'project', 'project', 'session'],
  )
  const reversed = model.pinned.map((item) => item.key).reverse()
  assert.deepEqual(
    buildSidebarModel(sources, { ...preferences, orders: { pinned: reversed } }).pinned.map((item) => item.key),
    reversed,
  )
})
test('合并列表使用完成时间或创建时间，并排除置顶项目所属聊天', () => {
  const sources = [{ serviceId: 'a', snapshot: snapshot() }]
  assert.deepEqual(
    buildSidebarModel(sources, { ...preferences, groupMode: 'merged' }).recents.map((item) => item.session.path),
    ['/older', '/newer', '/standalone'],
  )
  sources[0].snapshot.pinnedPaths = ['/project']
  assert.deepEqual(
    buildSidebarModel(sources, { ...preferences, groupMode: 'merged' }).recents.map((item) => item.session.path),
    ['/standalone'],
  )
})
test('手动排序保留已存顺序并追加新项，默认使用最近时间', () => {
  const sources = [{ serviceId: 'a', snapshot: snapshot() }]
  const projectKey = sidebarItemKey('a', 'project', '/project')
  const model = buildSidebarModel(sources, {
    ...preferences,
    groupMode: 'merged',
    sortMode: 'manual',
    orders: {
      recents: [sidebarItemKey('a', 'session', '/standalone'), '已删除'],
      [`project:${projectKey}`]: [sidebarItemKey('a', 'session', '/newer')],
    },
  })
  assert.deepEqual(
    model.recents.map((item) => item.session.path),
    ['/standalone', '/older', '/newer'],
  )
  assert.deepEqual(
    model.projects[0].project.sessions.map((item) => item.path),
    ['/newer', '/older'],
  )
})
test('搜索完整有效标题，不匹配正文、项目或路径，空查询只取最近九项', () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({
    kind: 'session' as const,
    key: String(index),
    serviceId: 'a',
    projectName: '不匹配项目',
    session: session(`/不匹配路径/${index}`, `2026-01-${String(index + 1).padStart(2, '0')}`, {
      firstMessage: `${'标题'.repeat(20)}尾部\n不匹配正文`,
      ...(index === 0 ? { name: '明确命名' } : {}),
    }),
  }))
  assert.equal(searchSidebarSessions(entries, '尾部').length, 11)
  assert.equal(searchSidebarSessions(entries, '不匹配').length, 0)
  assert.equal(searchSidebarSessions(entries, '明确命名').length, 1)
  assert.deepEqual(
    searchSidebarSessions(entries, ' ').map((entry) => entry.key),
    ['11', '10', '9', '8', '7', '6', '5', '4', '3'],
  )
})
test('重排移动到目标位置，无效键及相同键保持顺序', () => {
  assert.deepEqual(reorderSidebarItems(['a', 'b', 'c'], 'a', 'c'), ['b', 'c', 'a'])
  assert.deepEqual(reorderSidebarItems(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b'])
  assert.deepEqual(reorderSidebarItems(['a', 'b'], 'x', 'a'), ['a', 'b'])
})

test('首次进入手动排序保存当前顺序，新聊天追加尾部，切换模式保留已存顺序', () => {
  const sources = [{ serviceId: 'a', snapshot: snapshot(['/project']) }]
  const initial = buildSidebarModel(sources, { ...preferences, groupMode: 'merged' })
  const existing = { custom: ['保留'] }
  const orders = sidebarManualOrders(initial, existing)
  const projectKey = sidebarItemKey('a', 'project', '/project')
  assert.deepEqual(orders[`project:${projectKey}`], [
    sidebarItemKey('a', 'session', '/older'),
    sidebarItemKey('a', 'session', '/newer'),
  ])
  assert.deepEqual(orders.custom, ['保留'])
  const latest = session('/latest', '2026-06-01')
  sources[0].snapshot.projects[0].sessions.push(latest)
  sources[0].snapshot.projects[0].sessionCount += 1
  sources[0].snapshot.recents.push(latest)
  const manualPreferences = { ...preferences, groupMode: 'merged' as const, sortMode: 'manual' as const, orders }
  const manual = buildSidebarModel(sources, manualPreferences)
  const manualProject = manual.pinned.find((entry) => entry.kind === 'project')!
  assert.equal(manualProject.kind, 'project')
  if (manualProject.kind === 'project')
    assert.deepEqual(
      manualProject.project.sessions.map((entry) => entry.path),
      ['/older', '/newer', '/latest'],
    )
  const recent = buildSidebarModel(sources, { ...manualPreferences, sortMode: 'recent' })
  const nextOrders = sidebarManualOrders(recent, orders)
  assert.deepEqual(nextOrders[`project:${projectKey}`], [
    ...orders[`project:${projectKey}`],
    sidebarItemKey('a', 'session', '/latest'),
  ])
  assert.deepEqual(buildSidebarModel(sources, { ...manualPreferences, orders: nextOrders }).pinned, manual.pinned)
  assert.deepEqual(existing, { custom: ['保留'] })
  const groupedSource = [{ serviceId: 'a', snapshot: snapshot() }]
  const groupedInitial = buildSidebarModel(groupedSource, { ...preferences, groupMode: 'merged' })
  const groupedOrders = sidebarManualOrders(groupedInitial, {})
  assert.deepEqual(groupedOrders.projects, [projectKey])
  assert.deepEqual(groupedOrders[`project:${projectKey}`], orders[`project:${projectKey}`])
  groupedSource[0].snapshot.projects[0].sessions.push(latest)
  groupedSource[0].snapshot.recents.push(latest)
  const groupedManual = buildSidebarModel(groupedSource, { ...manualPreferences, orders: groupedOrders })
  assert.deepEqual(
    groupedManual.recents.map((entry) => entry.session.path),
    ['/older', '/newer', '/standalone', '/latest'],
  )
})

test('Worktree 聊天按项目会话归属或来源项目分组，不在最近重复展示', () => {
  const worktree = session('/worktree-session', '2026-07-01', {
    cwd: '/worktree',
    sourceProjectCwd: '/project',
    workspaceKind: 'project',
  })
  const source = snapshot()
  source.projects[0].sessions.push(worktree)
  source.projects[0].sessionCount += 1
  source.recents.push(worktree)
  const model = buildSidebarModel([{ serviceId: 'a', snapshot: source }], preferences)
  assert.deepEqual(
    model.recents.map((entry) => entry.session.path),
    ['/standalone'],
  )
  assert.equal(model.sessions.find((entry) => entry.session.path === worktree.path)?.projectName, '项目')
  source.projects[0].sessions.pop()
  const partialModel = buildSidebarModel([{ serviceId: 'a', snapshot: source }], preferences)
  assert.deepEqual(
    partialModel.recents.map((entry) => entry.session.path),
    ['/standalone'],
  )
  assert.equal(partialModel.sessions.find((entry) => entry.session.path === worktree.path)?.projectName, '项目')
})

test('连续新增聊天保存追加顺序，完成时间变化和切回最近不会挤到旧项前', () => {
  const sources = [{ serviceId: 'a', snapshot: snapshot() }]
  const state: SidebarPreferences = { ...preferences, groupMode: 'merged', sortMode: 'manual' }
  state.orders = sidebarManualOrders(buildSidebarModel(sources, state), {})
  const original = [...state.orders.recents]
  const projectKey = sidebarItemKey('a', 'project', '/project')
  const originalProject = [...state.orders[`project:${projectKey}`]]
  for (const [path, created] of [
    ['/first', '2026-06-01'],
    ['/second', '2026-07-01'],
  ]) {
    const added = session(path, created)
    sources[0].snapshot.projects[0].sessions.unshift(added)
    sources[0].snapshot.recents.unshift(added)
    state.orders = sidebarManualOrders(buildSidebarModel(sources, state), state.orders)
  }
  const addedKeys = ['/first', '/second'].map((path) => sidebarItemKey('a', 'session', path))
  assert.deepEqual(state.orders.recents, [...original, ...addedKeys])
  assert.deepEqual(state.orders[`project:${projectKey}`], [...originalProject, ...addedKeys])
  sources[0].snapshot.projects[0].sessions.find((item) => item.path === '/first')!.completedAt = '2026-08-01'
  const recent = buildSidebarModel(sources, { ...state, sortMode: 'recent' })
  state.orders = sidebarManualOrders(recent, state.orders)
  assert.deepEqual(
    buildSidebarModel(sources, state).recents.map((item) => item.key),
    [...original, ...addedKeys],
  )
})

test('补全所有列表保留移出项位置，新项目、置顶项和项目内聊天追加尾部', () => {
  const sources = [{ serviceId: 'a', snapshot: snapshot(['/project', '/standalone']) }]
  const state: SidebarPreferences = { ...preferences, sortMode: 'manual' }
  state.orders = sidebarManualOrders(buildSidebarModel(sources, state), { recents: ['已移出'], projects: ['旧项目'] })
  const before = structuredClone(state.orders)
  const added = session('/added', '2026-07-01')
  sources[0].snapshot.projects[0].sessions.unshift(added)
  sources[0].snapshot.projects.push({
    cwd: '/new-project',
    name: '新项目',
    sessionCount: 0,
    lastModified: '2026-08-01',
    sessions: [],
  })
  sources[0].snapshot.pinnedPaths.push('/newer')
  sources[0].snapshot.pinnedPaths = sources[0].snapshot.pinnedPaths.filter((path) => path !== '/standalone')
  sources[0].snapshot.recents.unshift(added)
  const next = sidebarManualOrders(buildSidebarModel(sources, state), state.orders)
  const projectKey = sidebarItemKey('a', 'project', '/project')
  assert.deepEqual(next.projects, [...before.projects, sidebarItemKey('a', 'project', '/new-project')])
  assert.deepEqual(next.pinned, [...before.pinned, sidebarItemKey('a', 'session', '/newer')])
  assert.deepEqual(next.recents, ['已移出', sidebarItemKey('a', 'session', '/standalone')])
  assert.deepEqual(next[`project:${projectKey}`], [
    ...before[`project:${projectKey}`],
    sidebarItemKey('a', 'session', '/added'),
  ])
  assert.deepEqual(state.orders, before)
  assert.deepEqual(sidebarManualOrders(buildSidebarModel(sources, { ...state, orders: next }), next), next)
})
