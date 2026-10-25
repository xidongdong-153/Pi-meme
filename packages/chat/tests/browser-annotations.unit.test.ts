import { describe, expect, it } from 'vitest'
import type { BrowserAnnotation } from '@pi-meme/contracts/browser'
import { browserAnnotationSummary, parseAnnotations } from '@pi-meme/contracts/browser-annotations'
import {
  annotationAttachment,
  messageWithAttachments,
  restoreAnnotationAttachments,
} from '../src/ui/composer/image-attachment'
import { queuedDraft } from '../src/ui/composer/restore-queued-input'
import { messageAttachmentParts } from '@pi-meme/contracts/chat-attachments'

const image = { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgo=' }
const annotation: BrowserAnnotation = {
  id: 'annotation',
  tabId: 'tab',
  documentId: 1,
  url: 'https://example.com/',
  title: '示例',
  capturedAt: '2026-10-25T00:00:00Z',
  kind: 'element',
  text: '发送',
  comment: '改为蓝色',
  rect: { x: 0, y: 0, width: 10, height: 20 },
  viewport: { width: 100, height: 100, scale: 2, scrollX: 0, scrollY: 0 },
  image,
}

describe('批注消息往返', () => {
  it('保留普通图片和文件，批注截图只发送一次', () => {
    const result = messageWithAttachments('请调整', [
      { ...image, id: 'image' },
      annotationAttachment(annotation),
      { id: 'file', type: 'file', name: 'readme.txt', path: '/tmp/readme.txt' },
    ])
    expect(result.images).toEqual([image, image])
    const files = messageAttachmentParts(result.message)
    expect(files.attachments[0].path).toBe('/tmp/readme.txt')
    const restored = restoreAnnotationAttachments(
      files.text,
      result.images.map((item, index) => ({ ...item, id: String(index) })),
    )
    expect(restored.text).toBe('请调整')
    expect(restored.attachments).toHaveLength(2)
    expect(restored.attachments[1].browserAnnotation).toEqual(annotation)
    expect(messageWithAttachments(restored.text, restored.attachments).images).toHaveLength(2)
  })
  it('队列编辑恢复批注身份、评论和图片', () => {
    const serialized = messageWithAttachments('正文', [annotationAttachment(annotation)])
    const restored = queuedDraft(
      { id: 'queue', text: serialized.message, images: serialized.images, mode: 'default' },
      [],
    )
    expect(restored.draft).toBe('正文')
    expect(restored.attachments[0]).toMatchObject({ id: annotation.id, browserAnnotation: annotation })
  })
  it('无截图批注可以单独发送，未识别内容保持原文', () => {
    const result = messageWithAttachments('', [annotationAttachment({ ...annotation, image: undefined })])
    expect(result.images).toHaveLength(0)
    expect(browserAnnotationSummary(result.message)).not.toContain('pi-meme.browser-annotations')
    expect(browserAnnotationSummary(result.message)).toContain(annotation.comment)
    expect(parseAnnotations(result.message, []).annotations[0].comment).toBe(annotation.comment)
    const malformed = result.message.slice(0, -1)
    expect(parseAnnotations(malformed, []).text).toBe(malformed)
  })
  it('缺少图片内容时仍识别批注身份，供恢复时防止重复加入', () => {
    const result = messageWithAttachments('正文', [annotationAttachment(annotation)])
    expect(parseAnnotations(result.message, []).annotations[0].id).toBe(annotation.id)
  })
})
