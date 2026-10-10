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
  update(value: ChatState | ((state: ChatState) => ChatState)) {
    const next = typeof value === 'function' ? value(this.value) : value
    if (next === this.value) return
    this.value = next
    for (const listener of this.listeners) listener()
  }
}
