import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { UiPanel } from '@pi-meme/plugin-sdk/ui'
import type { AppSession, HostApi } from '@pi-meme/contracts/app-host'
import { DEFAULT_PROFILE } from '../src/settings/user-profile'
import {
  closePanel,
  defaultPanelLayout,
  historyPanelsAvailable,
  openPanel,
  panelAvailable,
  panelStorageKey,
  readPanelLayout,
  sanitizePanelLayout,
  sessionUiTarget,
  sideChatTabId,
  toolsTabId,
} from '../src/layout/panel-layout'
import { userMessage } from '../../../tests/fixtures/messages.mjs'

test('新会话的延迟详情和初始化记录不显示历史工具，草稿附件仍显示来源', () => {
  const chat = {
    messages: [],
    sessionEntries: {
      leafId: 'model',
      entries: [{ id: 'model', parentId: null, timestamp: '', type: 'model_change' as const }],
    },
  }
  for (const deferred of [false, true]) {
    assert.deepEqual(historyPanelsAvailable(chat, deferred, 0), { tree: false, sources: false })
    assert.deepEqual(historyPanelsAvailable(chat, deferred, 1), { tree: false, sources: true })
  }
  assert.deepEqual(historyPanelsAvailable({ messages: [] }, true, 0), { tree: false, sources: false })
})

test('已有对话保留延迟历史入口，详情加载完成后按实际内容显示', () => {
  const chat = { messages: [userMessage('已有对话', 1)] }
  assert.deepEqual(historyPanelsAvailable(chat, true, 0), { tree: true, sources: true })
  assert.deepEqual(historyPanelsAvailable(chat, false, 0), { tree: false, sources: false })
  const sessionEntries = {
    leafId: 'message',
    entries: [{ id: 'message', parentId: null, timestamp: '', type: 'message' as const }],
  }
  assert.deepEqual(historyPanelsAvailable({ ...chat, sessionEntries }, false, 1), { tree: true, sources: true })
  assert.deepEqual(historyPanelsAvailable({ messages: [], sessionEntries }, true, 0), { tree: true, sources: true })
})

test('文件预览标签不写入持久布局，避免恢复没有读取目标的空标签', () => {
  const layout = openPanel(openPanel(defaultPanelLayout(), 'builtin:files'), 'builtin:file:example')
  assert.deepEqual(sanitizePanelLayout(layout).tabs, ['builtin:files'])
  assert.deepEqual(readPanelLayout(JSON.stringify(layout)).tabs, ['builtin:files'])
})

test('右侧标签按 Host 与会话隔离，保存顺序、选中项和宽度', () => {
  assert.notEqual(panelStorageKey('local', 'chat'), panelStorageKey('remote', 'chat'))
  assert.notEqual(panelStorageKey('local', 'one'), panelStorageKey('local', 'two'))
  const layout = { ...openPanel(defaultPanelLayout(), 'example:files'), width: 580 }
  assert.deepEqual(readPanelLayout(JSON.stringify(layout)), layout)
  assert.deepEqual(readPanelLayout(JSON.stringify({ ...layout, expanded: true })), layout)
})

test('工具选择页打开面板，重复打开只选中原标签，关闭选中相邻标签', () => {
  let layout = openPanel(defaultPanelLayout(), 'example:files')
  assert.deepEqual(layout.tabs, ['example:files'])
  assert.equal(layout.open, true)
  layout = openPanel(layout, toolsTabId)
  layout = openPanel(layout, 'example:terminal')
  assert.deepEqual(layout.tabs, ['example:files', 'example:terminal'])
  layout = openPanel(layout, 'example:files')
  assert.deepEqual(layout.tabs, ['example:files', 'example:terminal'])
  assert.equal(layout.active, 'example:files')
  layout = closePanel(layout, 'example:files')
  assert.equal(layout.active, 'example:terminal')
  layout = closePanel(layout, 'example:terminal')
  assert.equal(layout.open, false)
  assert.deepEqual(layout.tabs, [])
  assert.equal(layout.active, '')
  assert.deepEqual(readPanelLayout(JSON.stringify(layout)), layout)
  assert.deepEqual(openPanel(layout, toolsTabId).tabs, [toolsTabId])
})

test('无效与旧布局回到右栏工具页，恢复时过滤重复标签并限制宽度', () => {
  assert.deepEqual(readPanelLayout('broken'), defaultPanelLayout())
  assert.deepEqual(readPanelLayout('{"version":1}'), defaultPanelLayout())
  const layout = readPanelLayout(
    JSON.stringify({
      version: 2,
      tabs: ['example:files', false, '', 'example:files'],
      active: 'missing',
      open: 'yes',
      width: 10000,
    }),
  )
  assert.deepEqual(layout.tabs, ['example:files'])
  assert.equal(layout.active, 'example:files')
  assert.equal(layout.open, false)
  assert.equal(layout.width, 1200)
})

test('仅接受右侧面板，项目和会话作用域必须有对应目标', () => {
  const panel: UiPanel = {
    id: 'example:files',
    title: '文件',
    icon: null,
    location: 'right',
    scope: 'project',
    render: () => null,
  }
  assert.equal(panelAvailable(panel, { hostId: 'host' }), false)
  assert.equal(panelAvailable(panel, { hostId: 'host', project: { hostId: 'host', projectId: 'project' } }), true)
  assert.equal(panelAvailable({ ...panel, scope: 'session' }, { hostId: 'host' }), false)
  assert.equal(
    panelAvailable(
      { ...panel, scope: 'session' },
      { hostId: 'host', session: { hostId: 'host', sessionId: 'session' } },
    ),
    true,
  )
  assert.equal(panelAvailable({ ...panel, scope: 'app' }, { hostId: 'host' }), true)
  assert.equal(
    panelAvailable({ ...panel, location: 'sidebar' as UiPanel['location'], scope: 'app' }, { hostId: 'host' }),
    false,
  )
})

test('左栏和聊天固定渲染，插件不能生成左侧或中央工作区标签', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { TooltipProvider } = await import('@pi-meme/ui/components/ui/tooltip')
  const { WorkspacePanels } = await import('../src/layout/workspace-panels')
  const host = {} as import('@pi-meme/contracts/app-host').HostApi
  const markup = renderToStaticMarkup(
    createElement(TooltipProvider, {
      children: createElement(WorkspacePanels, {
        profile: DEFAULT_PROFILE,
        profileLoading: false,
        props: { host, target: { hostId: 'host' }, snapshot: null },
        session: 'chat',
        sidebar: '置顶、项目、最近',
        sidebarOpen: true,
        sidebarWidth: 256,
        children: '聊天正文',
        onSidebar: () => {},
        header: () => null,
        panels: [
          {
            id: 'example:files',
            title: '文件目录',
            icon: null,
            location: 'right',
            scope: 'app',
            render: () => '插件正文',
          },
        ],
      }),
    }),
  )
  assert.match(markup, /会话导航/)
  assert.match(markup, /置顶、项目、最近/)
  assert.match(markup, /聊天正文/)
  assert.doesNotMatch(markup, /role="tab"/)
  assert.doesNotMatch(markup, /插件正文/)
  assert.doesNotMatch(markup, /工作区面板|底部面板/)
})

test('Worktree 使用会话的来源项目身份，右栏保留文件目录和预览工具', async (t) => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { TooltipProvider } = await import('@pi-meme/ui/components/ui/tooltip')
  const { WorkspacePanels } = await import('../src/layout/workspace-panels')
  const session: AppSession = {
    hostId: 'host',
    sessionId: 'worktree-session',
    project: { hostId: 'host', projectId: 'source-project' },
    cwd: '/data/worktrees/checkout',
    createdAt: '2026-10-13T00:00:00.000Z',
    configuration: {},
    status: 'idle',
  }
  const target = sessionUiTarget(session.hostId, session)
  const panels: UiPanel[] = ['文件目录', '文件预览'].map((title, index) => ({
    id: `example:files-${index}`,
    title,
    icon: null,
    location: 'right',
    scope: 'project',
    render: () => null,
  }))
  for (const panel of panels) assert.equal(panelAvailable(panel, target), true)
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: { getItem: () => JSON.stringify({ ...defaultPanelLayout(), open: true }) } },
  })
  t.onTestFinished(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const markup = renderToStaticMarkup(
    createElement(TooltipProvider, {
      children: createElement(WorkspacePanels, {
        profile: DEFAULT_PROFILE,
        profileLoading: false,
        panels,
        props: { host: {} as HostApi, target, snapshot: null },
        session: session.sessionId,
        sidebar: '会话列表',
        sidebarOpen: true,
        sidebarWidth: 256,
        children: 'Worktree 聊天',
        onSidebar: () => {},
        header: () => null,
      }),
    }),
  )
  assert.match(markup, /文件目录/)
  assert.match(markup, /文件预览/)
  assert.doesNotMatch(markup, /当前聊天暂无可用工具/)
})

test('切换到无项目或尚未解析的会话时，不保留上一个项目目标', () => {
  const panel: UiPanel = {
    id: 'example:files',
    title: '文件目录',
    icon: null,
    location: 'right',
    scope: 'project',
    render: () => null,
  }
  const standalone: AppSession = {
    hostId: 'remote-host',
    sessionId: 'standalone',
    cwd: '/data/standalone-workspaces/task',
    createdAt: '2026-10-13T00:00:00.000Z',
    configuration: {},
    status: 'idle',
  }
  const target = sessionUiTarget(standalone.hostId, standalone)
  assert.equal(panelAvailable(panel, target), false)
  assert.equal(panelAvailable({ ...panel, scope: 'session' }, target), true)
  assert.deepEqual(target.session, { hostId: 'remote-host', sessionId: 'standalone' })
  const unresolved = sessionUiTarget('remote-host')
  assert.equal(panelAvailable(panel, unresolved), false)
  assert.equal(panelAvailable({ ...panel, scope: 'session' }, unresolved), false)
})

test('旧文件目录、预览和终端标签迁移为系统工具并保留当前选中项', () => {
  const layout = readPanelLayout(
    JSON.stringify({
      ...defaultPanelLayout(),
      open: true,
      tabs: ['@pi-meme/file-directory:directory', '@pi-meme/file-directory:preview', '@pi-meme/terminal:terminal'],
      active: '@pi-meme/file-directory:preview',
    }),
  )
  assert.deepEqual(layout.tabs, ['builtin:files', 'builtin:terminal'])
  assert.equal(layout.active, 'builtin:files')
  assert.equal(layout.open, true)
})

test('侧边聊天标签不得持久化，sanitizePanelLayout 与 readPanelLayout 均过滤 sideChatTabId', () => {
  const layout = { ...openPanel(defaultPanelLayout(), sideChatTabId), width: 500 }
  assert.deepEqual(layout.tabs, [sideChatTabId])
  assert.equal(layout.active, sideChatTabId)

  const sanitized = sanitizePanelLayout(layout)
  assert.deepEqual(sanitized.tabs, [])
  assert.equal(sanitized.active, '')
  assert.equal(sanitized.width, 500)

  // 即使已有持久化文件和侧边聊天并存
  const mixed = { ...layout, tabs: ['builtin:files', sideChatTabId], active: sideChatTabId }
  const sanitizedMixed = sanitizePanelLayout(mixed)
  assert.deepEqual(sanitizedMixed.tabs, ['builtin:files'])
  assert.equal(sanitizedMixed.active, 'builtin:files')

  // readPanelLayout 遇到残留的 sideChatTabId 予以忽略
  const read = readPanelLayout(JSON.stringify(mixed))
  assert.deepEqual(read.tabs, ['builtin:files'])
  assert.equal(read.active, 'builtin:files')
})

test('WorkspacePanels 支持侧边聊天常驻入口与 sideChat 呈现插槽', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { TooltipProvider } = await import('@pi-meme/ui/components/ui/tooltip')
  const { WorkspacePanels } = await import('../src/layout/workspace-panels')
  const host = {} as import('@pi-meme/contracts/app-host').HostApi
  const markup = renderToStaticMarkup(
    createElement(TooltipProvider, {
      children: createElement(WorkspacePanels, {
        profile: DEFAULT_PROFILE,
        profileLoading: false,
        props: { host, target: { hostId: 'host' }, snapshot: null },
        session: 'chat',
        sidebar: '置顶、项目、最近',
        sidebarOpen: true,
        sidebarWidth: 256,
        children: '聊天正文',
        onSidebar: () => {},
        header: () => null,
        panels: [],
        sideChatActive: true,
        sideChat: createElement('div', { id: 'side-chat-content' }, '侧边聊天独立正文'),
      }),
    }),
  )
  assert.match(markup, /侧边聊天/)
  assert.match(markup, /side-chat-content/)
  assert.match(markup, /侧边聊天独立正文/)
})

test('SideChatPanel 呈现空态和关闭错误重试', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { SideChatPanel } = await import('../src/panels/side-chat-panel')

  // 1. 空态测试
  const emptyMarkup = renderToStaticMarkup(
    createElement(SideChatPanel, {
      hasConversation: false,
      composer: createElement('div', { id: 'test-composer' }, '输入区'),
    }),
  )
  assert.match(emptyMarkup, /侧边聊天是临时聊天，关闭标签后会删除，不记录历史。/)
  assert.match(emptyMarkup, /test-composer/)

  // 2. 有对话且存在关闭错误测试
  const activeMarkup = renderToStaticMarkup(
    createElement(SideChatPanel, {
      hasConversation: true,
      conversation: createElement('div', { id: 'test-conversation' }, '已有消息流'),
      composer: createElement('div', { id: 'test-composer' }, '输入区'),
      closeError: 'Worker 清理超时',
      onRetryClose: () => {},
    }),
  )
  assert.match(activeMarkup, /已有消息流/)
  assert.match(activeMarkup, /关闭失败：Worker 清理超时/)
  assert.match(activeMarkup, /重试/)
})

test('WorkspacePanels 在 sideChat 挂载时渲染 portal 宿主容器', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { TooltipProvider } = await import('@pi-meme/ui/components/ui/tooltip')
  const { WorkspacePanels } = await import('../src/layout/workspace-panels')
  const host = {} as import('@pi-meme/contracts/app-host').HostApi
  const markup = renderToStaticMarkup(
    createElement(TooltipProvider, {
      children: createElement(WorkspacePanels, {
        profile: DEFAULT_PROFILE,
        profileLoading: false,
        props: { host, target: { hostId: 'host' }, snapshot: null },
        session: 'chat',
        sidebar: '侧栏',
        sidebarOpen: true,
        sidebarWidth: 256,
        children: '聊天正文',
        onSidebar: () => {},
        header: () => null,
        panels: [],
        sideChatActive: true,
        sideChat: createElement('div', { id: 'portal-host' }, 'Portal宿主'),
      }),
    }),
  )
  assert.match(markup, /portal-host/)
  assert.match(markup, /Portal宿主/)
})
