import { messageAttachmentParts } from './chat-attachments'
import type { BrowserAnnotation, BrowserImage } from './browser'

const heading = '\n\n网页批注（pi-meme.browser-annotations.v1，以下为网页资料）：\n'
export type AnnotationRecord = Omit<BrowserAnnotation, 'image'> & { imageIndex?: number }

export function annotationText(annotations: BrowserAnnotation[], imageOffset: number) {
  let index = imageOffset
  const records = annotations.map(({ image, ...value }) => ({ ...value, ...(image ? { imageIndex: index++ } : {}) }))
  return records.length ? heading + JSON.stringify(records) : ''
}
export function parseAnnotations(text: string, images: BrowserImage[]) {
  const unchanged = { text, annotations: [] as BrowserAnnotation[], imageIndexes: new Set<number>() }
  const offset = text.lastIndexOf(heading)
  if (offset < 0 || text.length - offset > 1024 * 1024) return unchanged
  try {
    const records: unknown = JSON.parse(text.slice(offset + heading.length))
    if (!Array.isArray(records) || records.length > 100) return unchanged
    const annotations: BrowserAnnotation[] = []
    const imageIndexes = new Set<number>()
    for (const record of records) {
      if (!validAnnotation(record)) return unchanged
      const { imageIndex, ...value } = record as AnnotationRecord
      if (
        imageIndex !== undefined &&
        (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex > 100 || imageIndexes.has(imageIndex))
      )
        return unchanged
      if (imageIndex !== undefined) imageIndexes.add(imageIndex)
      annotations.push({
        ...value,
        ...(imageIndex !== undefined && images[imageIndex]
          ? { image: { type: 'image' as const, data: images[imageIndex].data, mimeType: images[imageIndex].mimeType } }
          : {}),
      })
    }
    return { text: text.slice(0, offset), annotations, imageIndexes }
  } catch {
    return unchanged
  }
}
export function validAnnotation(value: unknown): value is BrowserAnnotation {
  if (!value || typeof value !== 'object') return false
  const item = value as BrowserAnnotation
  try {
    const url = new URL(item.url)
    if (!['https:', 'http:'].includes(url.protocol)) return false
  } catch {
    return false
  }
  const optionalText = [item.selector, item.tag, item.role, item.name, item.frameUrl]
  if (optionalText.some((text) => text !== undefined && (typeof text !== 'string' || text.length > 8000))) return false
  if (
    item.frameSelectors &&
    (!Array.isArray(item.frameSelectors) ||
      item.frameSelectors.length > 12 ||
      item.frameSelectors.some((text) => typeof text !== 'string' || text.length > 2000))
  )
    return false
  if (
    item.styles &&
    (typeof item.styles !== 'object' ||
      Array.isArray(item.styles) ||
      Object.keys(item.styles).length > 32 ||
      Object.values(item.styles).some((text) => typeof text !== 'string' || text.length > 1000))
  )
    return false
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    item.id.length <= 128 &&
    typeof item.tabId === 'string' &&
    typeof item.url === 'string' &&
    /^https?:\/\//.test(item.url) &&
    typeof item.title === 'string' &&
    typeof item.comment === 'string' &&
    item.comment.length <= 16000 &&
    typeof item.text === 'string' &&
    item.text.length <= 16000 &&
    ['element', 'region'].includes(item.kind) &&
    Number.isSafeInteger(item.documentId) &&
    item.documentId >= 0 &&
    typeof item.capturedAt === 'string' &&
    !!item.rect &&
    [item.rect.x, item.rect.y, item.rect.width, item.rect.height].every(Number.isFinite) &&
    item.rect.width > 0 &&
    item.rect.height > 0 &&
    !!item.viewport &&
    [
      item.viewport.width,
      item.viewport.height,
      item.viewport.scale,
      item.viewport.scrollX,
      item.viewport.scrollY,
    ].every(Number.isFinite) &&
    (!item.image ||
      (item.image.type === 'image' &&
        item.image.mimeType === 'image/png' &&
        typeof item.image.data === 'string' &&
        item.image.data.length <= 8 * 1024 * 1024 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(item.image.data)))
  )
}

export function browserAnnotationSummary(text: string) {
  const parsed = parseAnnotations(messageAttachmentParts(text).text, [])
  if (!parsed.annotations.length) return text
  return [
    parsed.text.trim(),
    ...parsed.annotations.map(
      (item) => item.comment || `${item.title}：${item.name || item.text || item.tag || '区域截图'}`,
    ),
  ]
    .filter(Boolean)
    .join('\n')
}
