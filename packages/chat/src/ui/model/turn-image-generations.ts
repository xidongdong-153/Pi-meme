import type { PiImage } from '@pi-meme/contracts/pi'
import type { TurnActivity, TurnChunk } from './types'
import { extractImages } from './tool-details'

export type TurnImageGeneration = {
  id: string
  path?: string
  image?: PiImage & { id: string }
  status: 'running' | 'success'
  editing: boolean
}

const emptyGenerations: TurnImageGeneration[] = []
const collected = new WeakMap<readonly TurnActivity[], TurnImageGeneration[]>()
const galleryLists = new WeakMap<TurnChunk, TurnImageGeneration[]>()
const groupedGalleries = new WeakMap<readonly TurnChunk[], Map<string, TurnImageGeneration[]>>()

export function collectImageGenerations(activities: readonly TurnActivity[]): TurnImageGeneration[] {
  const cached = collected.get(activities)
  if (cached) return cached
  const results = new Map<string, TurnImageGeneration>()
  const visit = (items: readonly TurnActivity[]) => {
    for (const item of items) {
      if (item.type !== 'tool' && item.type !== undefined) continue
      if (item.name === 'image_gen' && item.status !== 'error') {
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
        })
      }
      if (item.children) visit(item.children)
    }
  }
  visit(activities)
  const images = results.size ? [...results.values()] : emptyGenerations
  collected.set(activities, images)
  return images
}

/** 子代理状态等会切开助手展示段，画廊仍按用户输入汇总到本轮最后一段。 */
export function groupTurnImageGenerations(turns: readonly TurnChunk[]) {
  const cached = groupedGalleries.get(turns)
  if (cached) return cached
  const galleries = new Map<string, TurnImageGeneration[]>()
  let images = new Map<string, TurnImageGeneration>()
  let previousKey: string | undefined
  for (const turn of turns) {
    if (turn.type === 'user') {
      images = new Map()
      previousKey = undefined
    } else if (turn.type === 'assistant_turn') {
      for (const image of collectImageGenerations(turn.activities)) images.set(image.id, image)
      if (previousKey) galleries.set(previousKey, emptyGenerations)
      const previous = galleryLists.get(turn)
      const next = images.size ? [...images.values()] : emptyGenerations
      const gallery =
        previous && previous.length === next.length && previous.every((image, index) => image === next[index])
          ? previous
          : next
      galleryLists.set(turn, gallery)
      galleries.set(turn.key, gallery)
      previousKey = turn.key
    }
  }
  groupedGalleries.set(turns, galleries)
  return galleries
}
