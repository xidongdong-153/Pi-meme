import type { ChatFileUpload, ChatUploadedFile } from '@pi-meme/contracts/chat-attachments'
import type { PiImage } from '@pi-meme/contracts/pi'
import { attachmentReferencesHeading } from '../model/message-attachments'

export type ComposerImageAttachment = PiImage & { id: string; name?: string }
export type ComposerAttachment =
  ComposerImageAttachment | (ChatUploadedFile & { id: string; type: 'file'; preview?: File })

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
  const files = attachments.filter((attachment) => attachment.type === 'file')
  const images = attachments
    .filter((attachment) => attachment.type === 'image')
    .map(({ type, data, mimeType }) => ({ type, data, mimeType }))
  const references = files.length
    ? `${attachmentReferencesHeading}\n${files.map(({ name, path }) => `- ${JSON.stringify(name)}：${JSON.stringify(path)}`).join('\n')}`
    : ''
  return { message: [text, references].filter(Boolean).join('\n\n'), images }
}
