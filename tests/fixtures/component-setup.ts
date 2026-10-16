import { afterEach, vi } from 'vitest'

// jsdom 不实现指针捕获与滚动布局；这里只补 Radix 交互所需的方法，几何行为由 E2E 验证。
HTMLElement.prototype.hasPointerCapture = () => false
HTMLElement.prototype.setPointerCapture = () => {}
HTMLElement.prototype.releasePointerCapture = () => {}
HTMLElement.prototype.scrollIntoView = () => {}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
