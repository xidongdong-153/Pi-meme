import type { DesktopEvent } from '@pi-meme/contracts/desktop'
import { mergeStreamUpdates } from '@pi-meme/contracts/stream-updates'

type Update = Extract<DesktopEvent['event'], { type: 'message_update' }>
type Delta = Extract<Update['assistantMessageEvent'], { type: 'text_delta' | 'thinking_delta' | 'toolcall_delta' }>

function delta(record: DesktopEvent): Delta | undefined {
  if (record.event.type !== 'message_update') return
  const update = record.event.assistantMessageEvent
  if (update.type === 'text_delta' || update.type === 'thinking_delta' || update.type === 'toolcall_delta')
    return update
}

/** 在 Host 编号之前合并相邻增量；内容块和语义事件始终保留原来的先后顺序。 */
export function createStreamCoalescer(emit: (record: DesktopEvent) => void) {
  let pending: DesktopEvent | undefined
  let bytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const value = pending
    pending = undefined
    bytes = 0
    if (value) emit(value)
  }
  return {
    flush,
    push(record: DesktopEvent) {
      const next = delta(record)
      const merged = pending && mergeStreamUpdates(pending, record)
      if (!next) {
        flush()
        emit(record)
        return
      }
      if (merged) {
        pending = merged
      } else {
        flush()
        pending = record
      }
      bytes += Buffer.byteLength(next.delta)
      if (bytes >= 32 * 1024) flush()
      else timer ??= setTimeout(flush, 16)
    },
  }
}
