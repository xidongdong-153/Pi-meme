import type { ImageLibraryItem } from '@pi-meme/contracts/image-library'
import type { GalleryImage } from '../images/image-library-data'

/** 资料身份独立于客户端连接；serviceId 仅用于找到对应连接。 */
export type MaterialRef = { hostId: string; kind: string; id: string }
export type MaterialSummary = {
  ref: MaterialRef
  serviceId: string
  name: string
  createdAt: string
  sourceLabel: string
  preview?: { width: number; height: number; mimeType: string }
}
export type RecentMaterial = Pick<MaterialSummary, 'ref' | 'serviceId' | 'name'> & { openedAt: number }
export type MaterialView = 'list' | 'grid' | 'masonry'
export type ImageMaterial = MaterialSummary & { ref: MaterialRef & { kind: 'image' }; image: GalleryImage }
export type MaterialAction = 'info' | 'rename' | 'download' | 'source' | 'remove'

export function materialKey(ref: MaterialRef) {
  return JSON.stringify([ref.hostId, ref.kind, ref.id])
}

export function imageOrigin(item: ImageLibraryItem) {
  return item.origin === 'uploaded' ? 'uploaded' : 'generated'
}

export function imageSourceLabel(item: GalleryImage) {
  if (item.origin === 'uploaded') return `已上传 · ${item.hostLabel}`
  const origin = item.sourceStatus === 'detached' ? '独立素材' : item.projectName || '独立聊天'
  return `${origin} · ${item.hostLabel}`
}

export function summarizeImage(image: GalleryImage): ImageMaterial {
  return {
    ref: { kind: 'image', hostId: image.hostId, id: image.id },
    serviceId: image.serviceId,
    name: image.name,
    createdAt: image.createdAt,
    sourceLabel: imageSourceLabel(image),
    preview: { width: image.width, height: image.height, mimeType: image.mimeType || 'image/png' },
    image,
  }
}
