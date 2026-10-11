import type { ActivityItem } from '../model/types'
import { MarkdownContent } from '../content/markdown-content'

export function NarrationActivityRow({ item }: { item: Extract<ActivityItem, { type: 'narration' }> }) {
  return (
    <div className="py-1.5 text-sm leading-relaxed text-foreground select-text">
      <MarkdownContent>{item.text}</MarkdownContent>
    </div>
  )
}
