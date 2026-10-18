import type { ThinkingLevel } from '@pi-meme/contracts/pi'

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: '关闭',
  minimal: '极小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}

export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${Math.round(count / 1_000_000)}M`
  }
  if (count >= 1_000) {
    return `${Math.round(count / 1_000)}K`
  }
  return String(Math.round(count))
}
