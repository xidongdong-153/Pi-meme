import type { DesktopEvent } from '@pi-meme/contracts/desktop'
import { mergeStreamUpdates } from '@pi-meme/contracts/stream-updates'

/** 可见会话按帧更新，后台缓存每 250ms 更新；语义边界立即提交。 */
export class SessionStreamEvents {
  private pending = new Map<string, { events: DesktopEvent[]; cancel: () => void }>()
  constructor(
    private readonly receive: (record: DesktopEvent) => void,
    private readonly visible: (key?: string) => boolean,
    private readonly retained: (key?: string) => boolean,
  ) {}
  push(record: DesktopEvent) {
    const key = record.sessionKey ?? ''
    const update = record.event.type === 'message_update' && record.event.assistantMessageEvent.type
    if (!update || !['text_delta', 'thinking_delta', 'toolcall_delta'].includes(update)) {
      this.flush(key)
      this.receive(record)
      return
    }
    if (!this.visible(record.sessionKey) && !this.retained(record.sessionKey)) return
    let pending = this.pending.get(key)
    if (!pending) {
      const active = this.visible(record.sessionKey) && !document.hidden
      const flush = () => this.flush(key)
      if (active && typeof requestAnimationFrame === 'function') {
        const frame = requestAnimationFrame(flush)
        pending = { events: [], cancel: () => cancelAnimationFrame(frame) }
      } else {
        const timer = setTimeout(flush, active ? 16 : 250)
        pending = { events: [], cancel: () => clearTimeout(timer) }
      }
      this.pending.set(key, pending)
    }
    const previous = pending.events.at(-1)
    const merged = previous && mergeStreamUpdates(previous, record)
    if (merged) pending.events[pending.events.length - 1] = merged
    else pending.events.push(record)
  }
  flush(key?: string) {
    for (const [id, pending] of this.pending) {
      if (key !== undefined && key !== id) continue
      this.pending.delete(id)
      pending.cancel()
      for (const record of pending.events) this.receive(record)
    }
  }
  dispose() {
    for (const pending of this.pending.values()) pending.cancel()
    this.pending.clear()
  }
}
