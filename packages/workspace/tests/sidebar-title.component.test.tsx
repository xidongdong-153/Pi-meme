import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { SidebarTitle } from '../src/ui/sidebar/sidebar-title'

let resize: () => void
const disconnect = vi.fn()

function renderTitle(text: string, available: number, width: number) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe() {}
      disconnect = disconnect
    },
  )
  const result = render(<SidebarTitle>{text}</SidebarTitle>)
  const viewport = result.container.firstElementChild as HTMLElement
  const label = viewport.firstElementChild as HTMLElement
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, get: () => available })
  Object.defineProperty(label, 'scrollWidth', { configurable: true, get: () => width })
  act(() => resize())
  return {
    ...result,
    viewport,
    resizeTo(nextAvailable: number, nextWidth = width) {
      available = nextAvailable
      width = nextWidth
      act(() => resize())
    },
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

test('短标题不启用渐隐或滑动，刚好放得下时也完整显示', () => {
  const title = renderTitle('短标题', 180, 60)
  expect(title.viewport.dataset.overflow).toBe('false')
  title.resizeTo(60)
  expect(title.viewport.dataset.overflow).toBe('false')
})

test('长标题只移动溢出的距离，按钮出现和侧栏变宽后重新测量', () => {
  const title = renderTitle('需要完整查看的长会话标题', 180, 300)
  expect(title.viewport.dataset.overflow).toBe('true')
  expect(title.viewport.style.getPropertyValue('--sidebar-title-offset')).toBe('-120px')
  title.resizeTo(150)
  expect(title.viewport.style.getPropertyValue('--sidebar-title-offset')).toBe('-150px')
  title.resizeTo(320)
  expect(title.viewport.dataset.overflow).toBe('false')
  expect(title.viewport.style.getPropertyValue('--sidebar-title-offset')).toBe('0px')
  title.unmount()
  expect(disconnect).toHaveBeenCalledOnce()
})
