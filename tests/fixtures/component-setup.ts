import { afterEach, beforeEach, vi } from 'vitest'

// jsdom 不实现指针捕获与滚动布局；这里只补 Radix 交互所需的方法，几何行为由 E2E 验证。
HTMLElement.prototype.hasPointerCapture = () => false
HTMLElement.prototype.setPointerCapture = () => {}
HTMLElement.prototype.releasePointerCapture = () => {}
HTMLElement.prototype.scrollIntoView = () => {}

// 只提供订阅接口，不模拟尺寸或触发回调；需要几何行为的用例自行提供观测数据。
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
