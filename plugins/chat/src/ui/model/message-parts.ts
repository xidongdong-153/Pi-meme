import { nestedTools } from './nested-tools'
import type { PiContent } from '@pi-meme/contracts/pi'
import type { ActivityItem, ChatState, RenderSegment } from './types'

export function groupMessageParts(
  parts: PiContent[],
  toolsMap: ChatState['tools'],
  isLive: boolean,
  completed: Record<number, boolean> = {},
): RenderSegment[] {
  const segments: RenderSegment[] = []
  let currentActivities: ActivityItem[] = []

  const flushActivities = () => {
    if (currentActivities.length > 0) {
      segments.push({ type: 'activity', items: currentActivities })
      currentActivities = []
    }
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part.type === 'toolCall' && part.id) {
      const toolRun = toolsMap[part.id]
      currentActivities.push({
        id: part.id,
        type: 'tool',
        name: part.name,
        args: part.arguments,
        result: toolRun?.result,
        children: nestedTools(part.id, toolsMap),
        status: toolRun?.status || (isLive ? 'running' : 'success'),
      })
    } else if (part.type === 'thinking') {
      const isLastPart = i === parts.length - 1
      currentActivities.push({
        id: `thinking-${i}`,
        type: 'thinking',
        thinking: part.thinking || '',
        status: isLive && isLastPart && !completed[i] ? 'running' : 'success',
      })
    } else if (part.type === 'text') {
      flushActivities()
      if (part.text) {
        segments.push({ type: 'text', text: part.text })
      }
    }
  }

  flushActivities()
  return segments
}
