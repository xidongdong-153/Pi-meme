import assert from 'node:assert/strict'
import test from 'node:test'
import type { UiPanel } from '@pi-meme/plugin-sdk/ui'
import {
  closePanel,
  defaultPanelLayout,
  openPanel,
  panelAvailable,
  panelStorageKey,
  readPanelLayout,
  toolsTabId,
} from '../src/panel-layout'

test('右侧标签按 Host 与会话隔离，保存顺序、选中项和宽度', () => {
  assert.notEqual(panelStorageKey('local', 'chat'), panelStorageKey('remote', 'chat'))
  assert.notEqual(panelStorageKey('local', 'one'), panelStorageKey('local', 'two'))
  const layout = { ...openPanel(defaultPanelLayout(), 'example:files'), width: 580, expanded: true }
  assert.deepEqual(readPanelLayout(JSON.stringify(layout)), layout)
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
  assert.deepEqual(layout.tabs, [toolsTabId])
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
  const { WorkspacePanels } = await import('../src/workspace-panels')
  const host = {} as import('@pi-meme/contracts/app-host').HostApi
  const markup = renderToStaticMarkup(
    createElement(WorkspacePanels, {
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
  )
  assert.match(markup, /会话导航/)
  assert.match(markup, /置顶、项目、最近/)
  assert.match(markup, /聊天正文/)
  assert.doesNotMatch(markup, /role="tab"/)
  assert.doesNotMatch(markup, /插件正文/)
  assert.doesNotMatch(markup, /工作区面板|底部面板/)
})
