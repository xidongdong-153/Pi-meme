import type { ChatState } from './types'

export class ChatStream {
  private readonly listeners = new Set<() => void>()
  private readonly viewListeners = new Set<() => void>()
  private view: ChatState
  private cancelView?: () => void
  constructor(private value: ChatState) {
    this.view = value
  }
  getSnapshot = () => this.value
  getViewSnapshot = () => this.view
  subscribeView = (listener: () => void) => {
    this.viewListeners.add(listener)
    return () => {
      this.viewListeners.delete(listener)
      if (!this.viewListeners.size) {
        this.cancelView?.()
        this.cancelView = undefined
        this.view = this.value
      }
    }
  }
  private publishView = () => {
    this.cancelView?.()
    this.cancelView = undefined
    if (this.view === this.value) return
    this.view = this.value
    for (const listener of this.viewListeners) listener()
  }
  private scheduleView() {
    if (this.cancelView || this.view === this.value) return
    if (!this.viewListeners.size) {
      this.view = this.value
      return
    }
    if (typeof requestAnimationFrame === 'function' && (typeof document === 'undefined' || !document.hidden)) {
      const frame = requestAnimationFrame(this.publishView)
      this.cancelView = () => cancelAnimationFrame(frame)
    } else {
      const timer = setTimeout(this.publishView, typeof document !== 'undefined' && document.hidden ? 250 : 16)
      this.cancelView = () => clearTimeout(timer)
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  select<T>(selector: (state: ChatState) => T, equal: (left: T, right: T) => boolean = Object.is) {
    let selected = selector(this.value)
    return {
      getSnapshot: () => {
        const next = selector(this.value)
        if (!equal(selected, next)) selected = next
        return selected
      },
      subscribe: (listener: () => void) =>
        this.subscribe(() => {
          const next = selector(this.value)
          if (equal(selected, next)) return
          selected = next
          listener()
        }),
    }
  }
  update(value: ChatState | ((state: ChatState) => ChatState), viewTiming: 'immediate' | 'frame' = 'immediate') {
    const next = typeof value === 'function' ? value(this.value) : value
    if (next !== this.value) {
      this.value = next
      // 业务与插件仍逐次读取完整状态；只有纯输出的 React 视图通知可以按帧合并。
      for (const listener of this.listeners) listener()
    }
    if (viewTiming === 'frame') this.scheduleView()
    else this.publishView()
  }
}
