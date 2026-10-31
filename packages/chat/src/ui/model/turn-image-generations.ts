import type { PiImage } from '@pi-meme/contracts/pi'
import type { ActivityItem, TurnChunk } from './types'
import { extractImages, formatDetailValue } from './tool-details'

export type TurnImageGeneration = {
  id: string
  path?: string
  image?: PiImage & { id: string }
  status: 'running' | 'success' | 'error'
  editing: boolean
  error?: string
}

export function collectImageGenerations(activities: readonly ActivityItem[]): TurnImageGeneration[] {
  const results = new Map<string, TurnImageGeneration>()
  const visit = (items: readonly ActivityItem[]) => {
    for (const item of items) {
      if (item.type === 'thinking' || item.type === 'narration') continue
      if (item.name === 'image_gen') {
        const result = item.result as { details?: { artifact?: { id?: string; path?: string } } } | undefined
        const artifact = result?.details?.artifact
        const args = item.args as { referenced_image_paths?: string[]; num_last_images_to_include?: number } | undefined
        const image = item.status === 'success' ? extractImages(item.result)[0] : undefined
        const id = artifact?.id ?? item.id
        results.set(id, {
          id,
          path: artifact?.path,
          image: image ? { ...image, type: 'image', id } : undefined,
          status: item.status ?? 'success',
          editing: Boolean(args?.referenced_image_paths?.length || args?.num_last_images_to_include),
          error: item.status === 'error' ? formatDetailValue(item.result) || '图片生成失败' : undefined,
        })
      }
      if (item.children) visit(item.children)
    }
  }
  visit(activities)
  return [...results.values()]
}

/** 子代理状态等会切开助手展示段，画廊仍按用户输入汇总到本轮最后一段。 */
export function groupTurnImageGenerations(turns: readonly TurnChunk[]) {
  const galleries = new Map<string, TurnImageGeneration[]>()
  let images = new Map<string, TurnImageGeneration>()
  let previousKey: string | undefined
  for (const turn of turns) {
    if (turn.type === 'user') {
      images = new Map()
      previousKey = undefined
    } else if (turn.type === 'assistant_turn') {
      for (const image of collectImageGenerations(turn.activities)) images.set(image.id, image)
      if (previousKey) galleries.set(previousKey, [])
      galleries.set(turn.key, [...images.values()])
      previousKey = turn.key
    }
  }
  return galleries
}
