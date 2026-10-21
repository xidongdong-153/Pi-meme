import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { HostService } from '@pi-meme/contracts/host'
import type { PiSessionSummary, PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import type { SidebarPreferences } from '@pi-meme/contracts/settings'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { buildSidebarModel } from '@pi-meme/workspace/ui/sidebar/sidebar-model'
import { Sidebar } from '@pi-meme/workspace/ui/sidebar/sidebar'
import { PinnedSection } from '@pi-meme/workspace/ui/sidebar/pinned-section'
import { ProjectsSection } from '@pi-meme/workspace/ui/sidebar/projects-section'
import { SidebarMenus } from '@pi-meme/workspace/ui/sidebar/sidebar-menus'
import { MultiServiceSidebar } from '../src/shell/multi-service-sidebar'

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
function render(services: HostService[], value: SidebarPreferences = preferences, preferencesLoaded = true): string {
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
        preferencesLoaded,
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
function draggableCount(markup: string): number {
  return attributes(markup, 'draggable').filter((value) => value === 'true').length
}

test('分项目显示按置顶、项目、最近排序，最近包含项目聊天且排除独立置顶聊天', () => {
  const markup = render([service('local', true, snapshot(['/pinned-child.jsonl']))])
  const groups = sections(markup)
  assert.deepEqual(Object.keys(groups), ['pinned', 'projects', 'recents'])
  assert.deepEqual(attributes(markup, 'data-project-cwd'), ['/project'])
  assert.deepEqual(attributes(groups.pinned, 'data-session-path'), ['/pinned-child.jsonl'])
  assert.deepEqual(attributes(groups.projects, 'data-session-path'), ['/project-chat.jsonl'])
  assert.deepEqual(attributes(groups.recents, 'data-session-path'), ['/project-chat.jsonl', '/standalone-chat.jsonl'])
  const recentPaths = attributes(groups.recents, 'data-session-path')
  assert.equal(new Set(recentPaths).size, recentPaths.length)
  assert.match(groups.projects, /aria-label="侧边栏显示选项"/)
  assert.doesNotMatch(groups.recents, /aria-label="侧边栏显示选项"/)
})

test('最近更新模式下项目和置顶项可拖拽，项目内聊天和最近不显示拖拽按钮', () => {
  const groups = sections(render([service('local', true, snapshot(['/pinned-child.jsonl']))]))
  assert.equal(draggableCount(groups.projects), 1)
  assert.equal(draggableCount(groups.pinned), 1)
  assert.equal(draggableCount(groups.recents), 0)

  const pinnedProject = sections(render([service('local', true, snapshot(['/project']))]))
  assert.equal(draggableCount(pinnedProject.pinned), 1)
  assert.equal(draggableCount(pinnedProject.recents), 0)
})

test('偏好读取完成前不启用项目和置顶区拖拽', () => {
  const groups = sections(render([service('local', true, snapshot(['/pinned-child.jsonl']))], preferences, false))
  assert.equal(draggableCount(groups.projects), 0)
  assert.equal(draggableCount(groups.pinned), 0)
  assert.equal(draggableCount(groups.recents), 0)
})

test('手动聊天排序仍启用项目内聊天和最近的拖拽', () => {
  const groups = sections(
    render([service('local', true, snapshot(['/pinned-child.jsonl']))], { ...preferences, sortMode: 'manual' }),
  )
  assert.equal(draggableCount(groups.projects), 2)
  assert.equal(draggableCount(groups.pinned), 1)
  assert.equal(draggableCount(groups.recents), 2)

  const pinnedProject = sections(
    render([service('local', true, snapshot(['/project']))], { ...preferences, sortMode: 'manual' }),
  )
  assert.equal(draggableCount(pinnedProject.pinned), 3)
  assert.equal(draggableCount(pinnedProject.recents), 1)
})

test('单服务分区独立控制顶层拖拽，不启用项目内聊天拖拽', () => {
  for (const pinnedPaths of [['/pinned-child.jsonl'], ['/project']]) {
    const model = buildSidebarModel([{ serviceId: 'local', snapshot: snapshot(pinnedPaths) }], preferences)
    for (const reorderEnabled of [false, true]) {
      const common = {
        collapsed: false,
        onToggle: noop,
        projectProps: {
          cwd: '/project',
          pinnedSet: new Set(pinnedPaths),
          onNewSessionInProject: noop,
          onSwitchSession: noop,
          onTogglePin: noop,
          onPrefetchSession: noop,
        },
        expandedProjects: new Set(['/project']),
        expandedProjectItemLimits: new Set<string>(),
        toggleProject: noop,
        toggleProjectItems: noop,
        sortable: false,
        reorderEnabled,
        onReorder: noop,
        onReorderSessions: noop,
      }
      const markup = renderToStaticMarkup(
        createElement(TooltipProvider, {
          children: createElement(SidebarMenus, {
            canOpenProject: false,
            bridge: {} as never,
            pinnedPaths,
            onNewSession: noop,
            onTogglePin: noop,
            onChanged: async () => {},
            onDeleted: async () => {},
            children: createElement(
              'div',
              null,
              createElement(PinnedSection, { ...common, entries: model.pinned }),
              createElement(ProjectsSection, {
                ...common,
                entries: model.projects,
                showAllProjects: true,
                onToggleAllProjects: noop,
                ready: true,
                onDirectory: noop,
              }),
            ),
          }),
        }),
      )
      const groups = sections(markup)
      assert.equal(draggableCount(groups.pinned), reorderEnabled ? model.pinned.length : 0)
      assert.equal(draggableCount(groups.projects), reorderEnabled ? model.projects.length : 0)
    }
  }
})

test('两个 Host 使用相同项目和聊天路径时分别保留入口，只消除同服务重复项', () => {
  const markup = render([service('local', true), service('remote', false)])
  const groups = sections(markup)
  assert.deepEqual(attributes(groups.projects, 'data-service-id'), ['local', 'remote'])
  assert.deepEqual(attributes(groups.projects, 'data-project-cwd'), ['/project', '/project'])
  for (const path of ['/project-chat.jsonl', '/pinned-child.jsonl', '/standalone-chat.jsonl']) {
    assert.equal(
      attributes(markup, 'data-session-path').filter((value) => value === path).length,
      path === '/standalone-chat.jsonl' ? 2 : 4,
    )
  }
  assert.deepEqual(attributes(groups.recents, 'data-service-id'), [
    'local',
    'local',
    'local',
    'remote',
    'remote',
    'remote',
  ])
  const itemKeys = attributes(markup, 'data-sidebar-item-key')
  assert.equal(itemKeys.length, 12)
  assert.equal(new Set(itemKeys).size, 8)
  assert.match(markup, /remote\.example\.test:3000/)
})

test('合并显示隐藏项目分区，最近标题提供显示选项和新聊天按钮', () => {
  const markup = render([service('local', true)], { ...preferences, groupMode: 'merged' })
  const groups = sections(markup)
  assert.deepEqual(Object.keys(groups), ['recents'])
  assert.deepEqual(attributes(markup, 'data-project-cwd'), [])
  assert.match(groups.recents, /aria-label="侧边栏显示选项"/)
  assert.match(groups.recents, /aria-label="新聊天"/)
  assert.doesNotMatch(markup, /aria-label="新建项目"/)
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
  assert.deepEqual(Object.keys(groups), ['pinned', 'recents'])
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
        canOpenProject: false,
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
