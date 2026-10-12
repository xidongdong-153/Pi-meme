import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { HostService } from '@pi-meme/contracts/host'
import type { PiSessionSummary, PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import type { SidebarPreferences } from '@pi-meme/contracts/settings'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { buildSidebarModel } from '@pi-meme/workspace/ui/sidebar/sidebar-model'
import { Sidebar } from '@pi-meme/workspace/ui/sidebar/sidebar'
import { MultiServiceSidebar } from '../src/multi-service-sidebar'

function noop() {}
const preferences: SidebarPreferences = {
  groupMode: 'projects',
  sortMode: 'recent',
  collapsed: { pinned: false, projects: false, recents: false },
  orders: {},
}
function session(path: string, standalone = false): PiSessionSummary {
  return {
    id: path,
    path,
    cwd: standalone ? '/standalone' : '/project',
    name: path,
    workspaceKind: standalone ? 'standalone' : 'project',
    messageCount: 1,
    created: '2026-10-12T00:00:00Z',
    modified: '2026-10-12T00:00:00Z',
  }
}
function snapshot(pinnedPaths: string[] = []): PiSessionsSnapshot {
  const child = session('/project-chat.jsonl')
  const pinnedChild = session('/pinned-child.jsonl')
  const standalone = session('/standalone-chat.jsonl', true)
  return {
    projects: [
      {
        cwd: '/project',
        name: '共享项目',
        sessionCount: 2,
        lastModified: child.modified,
        sessions: [child, pinnedChild],
      },
    ],
    standaloneSessions: [standalone],
    recents: [child, pinnedChild, standalone, standalone],
    pinnedPaths,
  }
}
function service(id: string, local: boolean, sessions = snapshot()): HostService {
  return {
    id,
    hostId: id,
    local,
    address: `http://${id}.example.test:3000`,
    status: 'connected',
    projects: [],
    sessions,
  }
}
function render(services: HostService[], value: SidebarPreferences = preferences): string {
  const model = buildSidebarModel(
    services.map((entry) => ({ serviceId: entry.id, snapshot: entry.sessions! })),
    value,
  )
  return renderToStaticMarkup(
    createElement(TooltipProvider, {
      children: createElement(MultiServiceSidebar, {
        services,
        registry: { get: () => ({ bridge: {} as never }) } as never,
        controllers: new Map(),
        activeId: services[0].id,
        model,
        preferences: value,
        preferenceError: '',
        onPreferencesChange: noop,
        onSearch: noop,
        onActivate: noop,
        onSettings: noop,
      }),
    }),
  )
}
function sections(markup: string): Record<string, string> {
  return Object.fromEntries(
    [...markup.matchAll(/<section data-sidebar-section="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)].map((match) => [
      match[1],
      match[2],
    ]),
  )
}
function attributes(markup: string, attribute: string): string[] {
  return [...markup.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))].map((match) => match[1])
}

test('多服务侧栏始终按置顶、项目、最近排序，同服务项目和聊天 DOM 各出现一次', () => {
  const markup = render([service('local', true, snapshot(['/pinned-child.jsonl']))])
  const groups = sections(markup)
  assert.deepEqual(Object.keys(groups), ['pinned', 'projects', 'recents'])
  assert.deepEqual(attributes(markup, 'data-project-cwd'), ['/project'])
  assert.deepEqual(attributes(groups.pinned, 'data-session-path'), ['/pinned-child.jsonl'])
  assert.deepEqual(attributes(groups.projects, 'data-session-path'), ['/project-chat.jsonl'])
  assert.deepEqual(attributes(groups.recents, 'data-session-path'), ['/standalone-chat.jsonl'])
  const paths = attributes(markup, 'data-session-path')
  assert.equal(new Set(paths).size, paths.length)
})

test('两个 Host 使用相同项目和聊天路径时分别保留入口，只消除同服务重复项', () => {
  const markup = render([service('local', true), service('remote', false)])
  const groups = sections(markup)
  assert.deepEqual(attributes(groups.projects, 'data-service-id'), ['local', 'remote'])
  assert.deepEqual(attributes(groups.projects, 'data-project-cwd'), ['/project', '/project'])
  for (const path of ['/project-chat.jsonl', '/pinned-child.jsonl', '/standalone-chat.jsonl']) {
    assert.equal(attributes(markup, 'data-session-path').filter((value) => value === path).length, 2)
  }
  assert.deepEqual(attributes(groups.recents, 'data-service-id'), ['local', 'remote'])
  const itemKeys = attributes(markup, 'data-sidebar-item-key')
  assert.equal(itemKeys.length, 8)
  assert.equal(new Set(itemKeys).size, 8)
  assert.match(markup, /remote\.example\.test:3000/)
})

test('合并显示的普通项目只保留入口，项目聊天只在最近列表各渲染一次', () => {
  const markup = render([service('local', true)], { ...preferences, groupMode: 'merged' })
  const groups = sections(markup)
  assert.deepEqual(attributes(groups.projects, 'data-project-cwd'), ['/project'])
  assert.deepEqual(attributes(groups.projects, 'data-session-path'), [])
  assert.deepEqual(attributes(groups.recents, 'data-session-path'), [
    '/project-chat.jsonl',
    '/pinned-child.jsonl',
    '/standalone-chat.jsonl',
  ])
  assert.equal(attributes(markup, 'data-session-path').length, 3)
})

test('合并显示保留置顶项目子聊天，独立置顶子聊天移出项目且不在最近重复', () => {
  const markup = render([service('local', true, snapshot(['/project', '/pinned-child.jsonl']))], {
    ...preferences,
    groupMode: 'merged',
  })
  const groups = sections(markup)
  assert.deepEqual(attributes(groups.pinned, 'data-project-cwd'), ['/project'])
  assert.deepEqual(attributes(groups.pinned, 'data-session-path'), ['/project-chat.jsonl', '/pinned-child.jsonl'])
  assert.deepEqual(attributes(groups.projects, 'data-project-cwd'), [])
  assert.deepEqual(attributes(groups.recents, 'data-session-path'), ['/standalone-chat.jsonl'])
  assert.equal(attributes(markup, 'data-session-path').length, 3)
  assert.match(groups.pinned, /aria-label="取消置顶：\/pinned-child\.jsonl"/)
  assert.match(groups.pinned, /aria-label="取消置顶项目：共享项目"/)
})

test('单服务和多服务没有置顶项时不渲染置顶分区', () => {
  for (const services of [[service('local', true)], [service('local', true), service('remote', false)]]) {
    assert.deepEqual(Object.keys(sections(render(services))), ['projects', 'recents'])
  }
  const singleMarkup = renderToStaticMarkup(
    createElement(TooltipProvider, {
      children: createElement(Sidebar, {
        cwd: '/project',
        projectName: '共享项目',
        ready: true,
        status: '',
        sessionsSnapshot: snapshot(),
        sessionsLoading: false,
        menuBridge: {} as never,
        onMenuChanged: async () => {},
        onMenuDeleted: async () => {},
        onSelectProject: noop,
        onDirectory: noop,
        onNewSession: noop,
        onNewSessionInProject: noop,
        onSwitchSession: noop,
        onTogglePin: noop,
        onPrefetchSession: noop,
        onSettings: noop,
      }),
    }),
  )
  assert.deepEqual(Object.keys(sections(singleMarkup)), ['projects', 'recents'])
})

test('折叠的三个分区标题常驻，内容保留 grid 动画并立即标记 inert 和 aria-hidden', () => {
  const groups = sections(
    render([service('local', true, snapshot(['/pinned-child.jsonl']))], {
      ...preferences,
      collapsed: { pinned: true, projects: true, recents: true },
    }),
  )
  for (const [id, title] of [
    ['pinned', '置顶'],
    ['projects', '项目'],
    ['recents', '最近'],
  ]) {
    assert.match(groups[id], new RegExp(`aria-expanded="false"[^>]*>[\\s\\S]*?${title}`))
    assert.match(groups[id], /<div id="[^"]+"[^>]*inert=""[^>]*aria-hidden="true"/)
    assert.match(groups[id], /grid-rows-\[0fr\]/)
    assert.doesNotMatch(groups[id], / hidden=""/)
  }
})
