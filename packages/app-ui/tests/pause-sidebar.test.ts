import assert from 'node:assert/strict'
import { test } from 'node:test'
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

test('普通和置顶项目只有存在未暂停运行会话时转圈', () => {
  for (const isPinned of [false, true]) {
    const item = (sessions: PiSessionSummary[]) => {
      const value = project(sessions)
      return render(
        isPinned
          ? createElement(PinnedSection, {
              pinnedProjects: [value],
              pinnedSessions: [],
              expandedProjects: new Set<string>(),
              toggleProject: noop,
              onNewSessionInProject: noop,
              onTogglePin: noop,
              onSwitchSession: noop,
              onPrefetchSession: noop,
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
    assert.doesNotMatch(item([{ ...session, isPaused: true }]), /项目内有会话运行中/)
    assert.match(
      item([
        { ...session, isPaused: true },
        { ...session, id: 'other', path: '/tmp/other.jsonl', isPaused: false },
      ]),
      /项目内有会话运行中/,
    )
    assert.doesNotMatch(item([{ ...session, running: false, isPaused: false }]), /项目内有会话运行中/)
  }
})
