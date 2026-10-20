import type { ChatState } from './types'

export class ChatStream {
  private readonly listeners = new Set<() => void>()
  constructor(private value: ChatState) {}
  getSnapshot = () => this.value
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
  update(value: ChatState | ((state: ChatState) => ChatState)) {
    const next = typeof value === 'function' ? value(this.value) : value
    if (next === this.value) return
    this.value = next
    for (const listener of this.listeners) listener()
  }
}
