import type { ActivityItem } from '../model/types'
import { ActivityGroup } from './activity-group'

export function ThinkingBlock({
  content,
  isLive = false,
  className,
}: {
  content: string
  isLive?: boolean
  className?: string
}) {
  if (!content && !isLive) return null

  const items: ActivityItem[] = [
    {
      id: 'thinking',
      type: 'thinking',
      thinking: content,
      status: isLive ? 'running' : 'success',
    },
  ]

  return <ActivityGroup items={items} isLive={isLive} className={className} />
}
