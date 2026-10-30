import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import type { PiProjectGroup, PiSessionSummary } from '@pi-meme/contracts/sessions'
import { SessionItem } from '@pi-meme/workspace/ui/sidebar/session-item'
import { ProjectItem } from '@pi-meme/workspace/ui/sidebar/project-item'
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
    createElement(
      TooltipProvider,
      null,
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
    ),
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
    assert.doesNotMatch(item(true), /会话运行中/)
    assert.match(item(false), /会话运行中/)
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
