import type { BrowserAnnotation } from '@pi-meme/contracts/browser'
import { annotationText, parseAnnotations } from '@pi-meme/contracts/browser-annotations'
import type { ChatFileUpload, ChatUploadedFile } from '@pi-meme/contracts/chat-attachments'
import type { PiImage } from '@pi-meme/contracts/pi'
import { attachmentReferencesHeading } from '../model/message-attachments'

export type ComposerImageAttachment = PiImage & { id: string; name?: string; browserAnnotation?: BrowserAnnotation }
export type ComposerAttachment =
  | ComposerImageAttachment
  | (ChatUploadedFile & { id: string; type: 'file'; preview?: File; browserAnnotation?: BrowserAnnotation })

export type ComposerPendingAttachment = {
  id: string
  type: 'file'
  name: string
  preview?: File
  progress: number
}

export function filePreview(file: File) {
  return file.type.startsWith('image/') || /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i.test(file.name)
    ? file
    : undefined
}

export async function fileToAttachment(
  file: File,
  upload: (input: ChatFileUpload) => Promise<ChatUploadedFile>,
  id: string = crypto.randomUUID(),
): Promise<ComposerAttachment> {
  return {
    ...(await upload({ name: file.name, data: file })),
    id,
    type: 'file',
    preview: filePreview(file),
  }
}

export function messageWithAttachments(text: string, attachments: ComposerAttachment[]) {
  const files = attachments.filter(
    (attachment): attachment is Extract<ComposerAttachment, { type: 'file' }> =>
      attachment.type === 'file' && !attachment.browserAnnotation,
  )
  const images = attachments
    .filter(
      (attachment): attachment is ComposerImageAttachment =>
        attachment.type === 'image' && !attachment.browserAnnotation,
    )
    .map(({ type, data, mimeType }) => ({ type, data, mimeType }))
  const annotations = attachments.flatMap((attachment) =>
    attachment.browserAnnotation ? [attachment.browserAnnotation] : [],
  )
  if (annotations.length && !text.trim()) text = '请分析所附的网页批注。'
  const annotationBlock = annotationText(annotations, images.length)
  images.push(...annotations.flatMap((annotation) => (annotation.image ? [annotation.image] : [])))
  const references = files.length
    ? `${attachmentReferencesHeading}\n${files.map(({ name, path }) => `- ${JSON.stringify(name)}：${JSON.stringify(path)}`).join('\n')}`
    : ''
  return { message: [text + annotationBlock, references].filter(Boolean).join('\n\n'), images }
}

export function annotationAttachment(annotation: BrowserAnnotation): ComposerAttachment {
  return {
    id: annotation.id,
    name: `网页批注：${annotation.comment || annotation.tag || '区域'}`,
    type: 'file',
    path: '',
    browserAnnotation: annotation,
  }
}

export function restoreAnnotationAttachments(text: string, images: ComposerImageAttachment[]) {
  const parsed = parseAnnotations(text, images)
  return {
    text: parsed.text,
    attachments: [
      ...images.filter((_image, index) => !parsed.imageIndexes.has(index)),
      ...parsed.annotations.map(annotationAttachment),
    ],
  }
}
