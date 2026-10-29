import { validateVisualizationRef, type VisualizationRef } from '@pi-meme/contracts/visualize'
import type { ActivityItem } from './types'

export function turnVisualizations(activities: readonly ActivityItem[]): VisualizationRef[] {
  const references = new Map<string, VisualizationRef>()
  const visit = (items: readonly ActivityItem[]) => {
    for (const item of items) {
      if (item.type === 'thinking' || item.type === 'narration') continue
      if (item.name === 'save_visualization' && item.status === 'success') {
        const reference = (item.result as { details?: { visualization?: unknown } } | undefined)?.details?.visualization
        try {
          validateVisualizationRef(reference)
          references.set(`${reference.id}:${reference.revision}`, { id: reference.id, revision: reference.revision })
        } catch {
          // 无效结果不生成预览，工具详情仍保留原始结果。
        }
      }
      if (item.children) visit(item.children)
    }
  }
  visit(activities)
  return [...references.values()]
}
