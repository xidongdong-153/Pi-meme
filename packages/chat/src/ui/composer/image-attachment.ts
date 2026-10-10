import type { PiImage } from '@pi-meme/contracts/pi'

export type ComposerAttachment = PiImage & { id: string }

export function imageToAttachment(file: File): Promise<ComposerAttachment> {
  return new Promise((resolve, reject) => {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      reject(new Error(`不支持的图片格式：${file.type || '未知'}`))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`无法读取图片：${file.name || file.type}`))
    reader.onload = () => {
      const value = String(reader.result ?? '')
      const data = value.slice(value.indexOf(',') + 1)
      resolve({ id: crypto.randomUUID(), type: 'image', data, mimeType: file.type })
    }
    reader.readAsDataURL(file)
  })
}
