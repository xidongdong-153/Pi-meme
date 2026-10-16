import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { HostApi } from '@pi-meme/contracts/app-host'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { WorkspacePanels } from '../src/layout/workspace-panels'

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

function Panes({ onSidebar }: { onSidebar?: (open: boolean, width: number) => void }) {
  const [open, setOpen] = useState(true)
  const [width, setWidth] = useState(256)
  return (
    <TooltipProvider>
      <WorkspacePanels
        panels={[]}
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

test('右侧栏开关留在顶栏，展开后不另挂收起按钮', () => {
  render(<Panes />)
  const toggle = screen.getByRole('button', { name: '展开右侧栏' })
  fireEvent.click(toggle)
  expect(screen.getByRole('button', { name: '收起右侧栏' })).toBe(toggle)
  expect(screen.getAllByRole('button', { name: '收起右侧栏' })).toHaveLength(1)
  const paneHeader = document.querySelector('[data-testid="right-panel-header"]')
  if (!(paneHeader instanceof HTMLElement)) throw new Error('缺少右侧栏顶栏')
  expect(paneHeader).toHaveClass('absolute', 'right-0')
  expect(paneHeader.contains(toggle)).toBe(false)
  expect(paneHeader.querySelector('.pane-clip')).toHaveClass('right-0')
})
