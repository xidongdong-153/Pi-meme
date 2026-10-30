import type { PiImage } from './pi'

export const MAX_CHAT_ATTACHMENT_BYTES = 50 * 1024 * 1024

export type ChatFileUpload = {
  name: string
  data: Blob
}

export type ChatUploadedFile = {
  name: string
  path: string
}

export const attachmentReferencesHeading = '附加文件（请按需读取）：'

/** 只分离发送器追加的完整结尾块，格式不匹配时保留原文。 */
export function messageAttachmentParts(text: string): { text: string; attachments: ChatUploadedFile[] } {
  const unchanged = { text, attachments: [] }
  const [heading, start] = [attachmentReferencesHeading, '附加文件（Host 路径，请按需读取）：']
    .map((value) => [value, text.lastIndexOf(`${value}\n`)] as const)
    .sort((a, b) => b[1] - a[1])[0]
  if (start < 0 || (start > 0 && text.slice(start - 2, start) !== '\n\n')) return unchanged
  const attachments: ChatUploadedFile[] = []
  for (const line of text.slice(start + heading.length + 1).split('\n')) {
    const match = /^- ("(?:[^"\\]|\\.)*")：("(?:[^"\\]|\\.)*")$/.exec(line)
    if (!match) return unchanged
    try {
      const name: string = JSON.parse(match[1])
      const path: string = JSON.parse(match[2])
      if (!name || !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path)) return unchanged
      attachments.push({ name, path })
    } catch {
      return unchanged
    }
  }
  return { text: text.slice(0, start === 0 ? 0 : start - 2), attachments }
}

export type ChatBranchAttachment = {
  id: string
  entryId?: string
  name: string
  path?: string
  image?: PiImage
}
