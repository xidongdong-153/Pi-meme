import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { UiPanel } from '@pi-meme/plugin-sdk/ui'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { WorkspacePanels } from '../src/layout/workspace-panels'
import { DEFAULT_PROFILE } from '../src/settings/user-profile'

afterEach(cleanup)

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

function Panes({
  onSidebar,
  panels = [],
  onNewSession,
  onPlugins,
}: {
  onSidebar?: (open: boolean, width: number) => void
  panels?: UiPanel[]
  onNewSession?: () => void
  onPlugins?: () => void
}) {
  const [open, setOpen] = useState(true)
  const [width, setWidth] = useState(256)
  return (
    <TooltipProvider>
      <WorkspacePanels
        profile={DEFAULT_PROFILE}
        profileLoading={false}
        panels={panels}
        onNewSession={onNewSession}
        onPlugins={onPlugins}
        props={{ host: {} as HostApi, target: { hostId: 'host' }, snapshot: null }}
        session="chat"
        sidebar="会话列表"
        sidebarOpen={open}
        sidebarWidth={width}
        onSidebar={(next, size) => {
          onSidebar?.(next, size)
          setOpen(next)
          setWidth(size)
        }}
        header={(toggleSidebar) => (
          <button type="button" onClick={toggleSidebar}>
            切换侧栏
          </button>
        )}
      >
        聊天正文
      </WorkspacePanels>
    </TooltipProvider>
  )
}

function shell() {
  const node = document.querySelector('.workspace-panes')
  if (!(node instanceof HTMLElement)) throw new Error('缺少工作区')
  return node
}

test('折叠把侧栏宽度收到 0，动画结束前仍保留导航', () => {
  render(<Panes />)
  expect(shell().style.getPropertyValue('--workspace-sidebar-width')).toBe('256px')
  fireEvent.click(screen.getByRole('button', { name: '切换侧栏' }))
  expect(shell().style.getPropertyValue('--workspace-sidebar-width')).toBe('0px')
  expect(document.getElementById('workspace-sidebar')).not.toBeNull()
})

test('拖拽越界有阻尼，松手弹回上限', () => {
  const onSidebar = vi.fn()
  render(<Panes onSidebar={onSidebar} />)
  fireEvent.pointerDown(screen.getByRole('separator', { name: '调整侧边栏宽度' }), { button: 0, clientX: 0 })
  fireEvent.pointerMove(window, { clientX: 300 })
  const dragged = Number.parseFloat(shell().style.getPropertyValue('--workspace-sidebar-width'))
  expect(dragged).toBeGreaterThan(420)
  expect(dragged).toBeLessThan(256 + 300)
  fireEvent.pointerUp(window)
  expect(onSidebar).toHaveBeenCalledWith(true, 420)
})

test('拖过收起阈值后松手关闭，并保留原来的宽度', () => {
  const onSidebar = vi.fn()
  render(<Panes onSidebar={onSidebar} />)
  fireEvent.pointerDown(screen.getByRole('separator', { name: '调整侧边栏宽度' }), { button: 0, clientX: 400 })
  fireEvent.pointerMove(window, { clientX: 400 - 220 })
  fireEvent.pointerUp(window)
  expect(onSidebar).toHaveBeenCalledWith(false, 256)
})

test('窄窗口展开一侧时收起另一侧，并保留原栏宽', () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(660)
  const onSidebar = vi.fn()
  render(<Panes onSidebar={onSidebar} />)
  fireEvent.click(screen.getByRole('button', { name: '展开右侧栏' }))
  expect(shell()).toHaveAttribute('data-pane-sidebar', 'closed')
  expect(shell()).toHaveAttribute('data-pane-right', 'open')
  expect(onSidebar).toHaveBeenLastCalledWith(false, 256)

  fireEvent.click(screen.getByRole('button', { name: '切换侧栏' }))
  expect(shell()).toHaveAttribute('data-pane-sidebar', 'open')
  expect(shell()).toHaveAttribute('data-pane-right', 'closed')
  expect(onSidebar).toHaveBeenLastCalledWith(true, 256)
})

test.each([1280, 1024, 800])('容器宽 %d 时加宽右侧栏仍为聊天保留至少 480px', (width) => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
  render(<Panes />)
  fireEvent.click(screen.getByRole('button', { name: '展开右侧栏' }))
  fireEvent.click(screen.getByRole('button', { name: '加宽右侧栏' }))
  const leftWidth = Number.parseFloat(shell().style.getPropertyValue('--workspace-sidebar-width'))
  const rightWidth = Number.parseFloat(shell().style.getPropertyValue('--workspace-right-width'))
  expect(width - leftWidth - rightWidth).toBeGreaterThanOrEqual(480)
})

test('打开工具后仍可新增其他工具标签，并保留已有工具', () => {
  const panels: UiPanel[] = ['文件', '终端'].map((title) => ({
    id: `example:${title}`,
    title,
    icon: null,
    location: 'right',
    scope: 'app',
    render: () => `${title}正文`,
  }))
  render(<Panes panels={panels} />)
  fireEvent.click(screen.getByRole('button', { name: '展开右侧栏' }))
  fireEvent.click(screen.getByRole('button', { name: '文件' }))
  fireEvent.click(screen.getByRole('button', { name: '新建工具标签页' }))
  fireEvent.click(screen.getByRole('button', { name: '终端' }))
  expect(screen.getByRole('tab', { name: '文件' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: '终端' })).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(screen.getByRole('tab', { name: '文件' }))
  expect(screen.getByRole('tabpanel', { name: '文件' })).toHaveTextContent('文件正文')
})

test('新会话与扩展中心分别调用对应操作', () => {
  const onNewSession = vi.fn()
  const onPlugins = vi.fn()
  render(<Panes onNewSession={onNewSession} onPlugins={onPlugins} />)
  fireEvent.click(screen.getByRole('button', { name: '展开右侧栏' }))
  fireEvent.click(screen.getByRole('button', { name: '新会话' }))
  expect(onNewSession).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '扩展中心' }))
  expect(onPlugins).toHaveBeenCalledOnce()
})

test('键盘开合右侧栏后保留顶栏开关焦点', async () => {
  const user = userEvent.setup()
  render(<Panes />)
  const toggle = screen.getByRole('button', { name: '展开右侧栏' })
  toggle.focus()
  await user.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: '收起右侧栏' })).toBe(toggle)
  expect(toggle).toHaveFocus()
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getAllByRole('button', { name: '收起右侧栏' })).toHaveLength(1)
  expect(toggle.closest('.workspace-topbar')).not.toBeNull()

  await user.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: '展开右侧栏' })).toBe(toggle)
  expect(toggle).toHaveFocus()
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
})
