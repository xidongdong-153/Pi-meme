export const imageMimeTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const attachmentAccept = [...imageMimeTypes, 'text/*', 'application/json'].join(',')

export function readableAttachment(mime: string) {
  return imageMimeTypes.includes(mime) || mime.startsWith('text/') || mime === 'application/json'
}
