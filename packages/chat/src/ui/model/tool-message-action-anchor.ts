import type { MessageActionAnchor } from '@pi-meme/ui/components/plugin-message-actions'
import type { ActivityItem } from './types'
import { formatDetailValue, parseToolMeta } from './tool-details'

/** 摘要与详情共用同一工具结果引用，不为尚未落盘的活动构造消息 ID。 */
export function toolMessageActionAnchor(item: ActivityItem, displayedText?: string): MessageActionAnchor | undefined {
  if (item.type === 'thinking' || item.type === 'narration' || item.status === 'running' || !item.sourceEntry) return
  return {
    role: 'tool',
    entries: [{ ...item.sourceEntry }],
    displayedText: displayedText ?? (item.output || formatDetailValue(item.result ?? item.args)),
    state: item.status === 'error' ? 'error' : 'complete',
    source: item.source ? { ...item.source } : undefined,
    toolCallId: item.id,
    toolName: item.name ?? item.source?.toolName,
    label: parseToolMeta(item).summary,
  }
}
