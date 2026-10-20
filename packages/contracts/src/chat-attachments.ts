export const MAX_CHAT_ATTACHMENT_BYTES = 50 * 1024 * 1024

export type ChatFileUpload = {
  name: string
  data: Blob
}

export type ChatUploadedFile = {
  name: string
  path: string
}
