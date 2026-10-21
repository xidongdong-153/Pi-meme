import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PiProjectGroup, PiSessionSummary } from '@pi-meme/contracts/sessions'
import { SessionItem } from '@pi-meme/workspace/ui/sidebar/session-item'
import { ProjectItem } from '@pi-meme/workspace/ui/sidebar/project-item'
import { PinnedSection } from '@pi-meme/workspace/ui/sidebar/pinned-section'
import { SidebarMenus, type SidebarMenuBridge } from '@pi-meme/workspace/ui/sidebar/sidebar-menus'

function noop() {}
const session: PiSessionSummary = {
  id: 'session',
  path: '/tmp/session.jsonl',
  cwd: '/tmp/project',
  name: '当前任务',
  messageCount: 1,
  created: '2026-10-11T00:00:00Z',
  modified: '2026-10-11T00:00:00Z',
  running: true,
}
function project(sessions: PiSessionSummary[]): PiProjectGroup {
  return { cwd: session.cwd, name: '项目', sessions, sessionCount: sessions.length, lastModified: session.modified }
}
function render(children: ReactNode) {
  return renderToStaticMarkup(
    createElement(SidebarMenus, {
      canOpenProject: false,
      bridge: {} as SidebarMenuBridge,
      pinnedPaths: [],
      onNewSession: noop,
      onTogglePin: noop,
      onChanged: async () => {},
      onDeleted: async () => {},
      children,
    }),
  )
}

test('侧栏三类会话暂停时没有运行图标，恢复后重新转圈', () => {
  for (const variant of ['pinned', 'project', 'recent'] as const) {
    const item = (isPaused: boolean) =>
      render(
        createElement(SessionItem, {
          session: { ...session, isPaused },
          variant,
          isActive: false,
          onSwitchSession: noop,
          onTogglePin: noop,
        }),
      )
    assert.doesNotMatch(item(true), /会话运行中|animate-spin/)
    assert.match(item(false), /会话运行中/)
    assert.match(item(false), /animate-spin/)
  }
})

test('普通和置顶项目在运行、暂停和空闲状态下都显示静态目录图标', () => {
  for (const isPinned of [false, true]) {
    const item = (sessions: PiSessionSummary[]) => {
      const value = project(sessions)
      return render(
        isPinned
          ? createElement(PinnedSection, {
              entries: [{ kind: 'project', key: 'project', serviceId: 'local', project: value }],
              collapsed: false,
              onToggle: noop,
              projectProps: {
                cwd: '',
                onNewSessionInProject: noop,
                onTogglePin: noop,
                onSwitchSession: noop,
                onPrefetchSession: noop,
              },
              expandedProjectItemLimits: new Set<string>(),
              toggleProjectItems: noop,
              sortable: false,
              reorderEnabled: true,
              onReorder: noop,
              onReorderSessions: noop,
              expandedProjects: new Set<string>(),
              toggleProject: noop,
            })
          : createElement(ProjectItem, {
              project: value,
              cwd: '',
              isExpanded: false,
              isPinned: false,
              isItemsExpandedAll: false,
              onToggle: noop,
              onToggleItems: noop,
              onNewSessionInProject: noop,
              onTogglePin: noop,
              onSwitchSession: noop,
              onPrefetchSession: noop,
            }),
      )
    }
    for (const sessions of [
      [{ ...session, isPaused: true }],
      [
        { ...session, isPaused: true },
        { ...session, id: 'other', path: '/tmp/other.jsonl', isPaused: false },
      ],
      [{ ...session, running: false, isPaused: false }],
    ]) {
      const markup = item(sessions)
      assert.doesNotMatch(markup, /项目内有会话运行中/)
      assert.match(markup, /lucide-folder/)
      assert.equal((markup.match(/会话运行中/g) ?? []).length, sessions.filter((s) => s.running && !s.isPaused).length)
    }
  }
})

test('置顶项目复用项目展开列表，合并模式项目只显示入口', () => {
  const value = project([session])
  const props = {
    project: value,
    cwd: '',
    isExpanded: true,
    isPinned: false,
    isItemsExpandedAll: false,
    onToggle: noop,
    onToggleItems: noop,
    onNewSessionInProject: noop,
    onTogglePin: noop,
    onSwitchSession: noop,
    onPrefetchSession: noop,
  }
  const expanded = render(createElement(ProjectItem, props))
  assert.match(expanded, /aria-expanded="true"/)
  assert.match(expanded, /data-session-path="\/tmp\/session.jsonl"/)
  const merged = render(createElement(ProjectItem, { ...props, onSelectProject: noop }))
  assert.doesNotMatch(merged, /lucide-chevron-right|aria-expanded="true"/)
  assert.doesNotMatch(merged, /data-session-path/)
})
