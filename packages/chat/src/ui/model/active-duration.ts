import type { PiPauseInterval } from '@pi-meme/contracts/pi'

/** 只扣除与本轮工作时段重叠的暂停时间。 */
export function activeDuration(startedAt: number, endedAt: number, pauses: readonly PiPauseInterval[] = []): number {
  const end = Math.max(startedAt, endedAt)
  const overlaps = pauses
    .map((pause) => ({ start: Math.max(startedAt, pause.startedAt), end: Math.min(end, pause.endedAt ?? end) }))
    .filter((pause) => pause.end > pause.start)
    .sort((a, b) => a.start - b.start)
  let pausedMs = 0
  let previousEnd = startedAt
  for (const pause of overlaps) {
    pausedMs += Math.max(0, pause.end - Math.max(previousEnd, pause.start))
    previousEnd = Math.max(previousEnd, pause.end)
  }
  return Math.max(0, end - startedAt - pausedMs)
}
