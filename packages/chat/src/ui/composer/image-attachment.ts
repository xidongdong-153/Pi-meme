import type { ChatFileUpload, ChatUploadedFile } from '@pi-meme/contracts/chat-attachments'
import type { PiImage } from '@pi-meme/contracts/pi'

export type ComposerImageAttachment = PiImage & { id: string; name?: string }
export type ComposerAttachment =
  ComposerImageAttachment | (ChatUploadedFile & { id: string; type: 'file'; preview?: File })

export async function fileToAttachment(
  file: File,
  upload: (input: ChatFileUpload) => Promise<ChatUploadedFile>,
): Promise<ComposerAttachment> {
  const preview =
    file.type.startsWith('image/') || /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i.test(file.name)
  return {
    ...(await upload({ name: file.name, data: file })),
    id: crypto.randomUUID(),
    type: 'file',
    ...(preview ? { preview: file } : {}),
  }
}

export function messageWithAttachments(text: string, attachments: ComposerAttachment[]) {
  const files = attachments.filter((attachment) => attachment.type === 'file')
  const images = attachments
    .filter((attachment) => attachment.type === 'image')
    .map(({ type, data, mimeType }) => ({ type, data, mimeType }))
  const references = files.length
    ? `附加文件（Host 路径，请按需读取）：\n${files.map(({ name, path }) => `- ${JSON.stringify(name)}：${JSON.stringify(path)}`).join('\n')}`
    : ''
  return { message: [text, references].filter(Boolean).join('\n\n'), images }
}
