import { validateVisualizationRef, type VisualizationRef } from '@pi-meme/contracts/visualize'
import type { ActivityItem, AgentCollaborationStatus, RenderSegment } from './types'

type TurnSegment = RenderSegment | { type: 'collaboration'; item: AgentCollaborationStatus }
type VisualizationSegment = { type: 'visualization'; reference: VisualizationRef }

export function insertTurnVisualizations(segments: TurnSegment[]): Array<TurnSegment | VisualizationSegment> {
  const result: Array<TurnSegment | VisualizationSegment> = []
  const seen = new Set<string>()
  for (const segment of segments) {
    if (segment.type !== 'activity') {
      result.push(segment)
      continue
    }
    let pending: ActivityItem[] = []
    for (const item of segment.items) {
      pending.push(item)
      const references = turnVisualizations([item]).filter((reference) => {
        const key = `${reference.id}:${reference.revision}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (!references.length) continue
      result.push({ type: 'activity', items: pending })
      pending = []
      result.push(...references.map((reference) => ({ type: 'visualization' as const, reference })))
    }
    if (pending.length) result.push({ type: 'activity', items: pending })
  }
  return result
}

function turnVisualizations(activities: readonly ActivityItem[]): VisualizationRef[] {
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
