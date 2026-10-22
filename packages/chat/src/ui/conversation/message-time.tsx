import { useSyncExternalStore } from 'react'
import { formatMessageTime, formatMessageTimeTitle } from '../model/message-time'

const listeners = new Set<() => void>()
let now = Date.now()
let timer: ReturnType<typeof setInterval> | undefined

function readMessageClock(): number {
  return now
}

function subscribeMessageClock(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const item of listeners) item()
    }, 30_000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

export function MessageTime({ timestamp }: { timestamp?: number }) {
  const current = useSyncExternalStore(subscribeMessageClock, readMessageClock, readMessageClock)
  if (typeof timestamp !== 'number') return null
  const label = formatMessageTime(timestamp, current)
  const title = formatMessageTimeTitle(timestamp)
  if (!label || !title) return null
  return (
    <time
      dateTime={new Date(timestamp).toISOString()}
      title={title}
      aria-label={title}
      className="shrink-0 text-xs tabular-nums text-muted-foreground/70"
    >
      {label}
    </time>
  )
}
