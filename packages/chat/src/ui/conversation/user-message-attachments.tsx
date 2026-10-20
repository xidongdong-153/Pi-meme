import type { ChatUploadedFile } from '@pi-meme/contracts/chat-attachments'
import type { PiImage } from '@pi-meme/contracts/pi'
import { FileIcon } from '@pi-meme/ui/components/file-icon'
import { AttachmentPreview } from '../content/attachment-preview'
import { isImageLink, MessageImage } from '../content/message-image'

export function UserMessageAttachments({
  attachments,
  images,
}: {
  attachments: ChatUploadedFile[]
  images: Array<PiImage & { id?: string }>
}) {
  if (!attachments.length && !images.length) return null
  return (
    <div className="mb-2 flex max-w-full flex-wrap justify-end gap-2" aria-label="消息附件">
      {images.length > 0 && <AttachmentPreview images={images} className="my-0 justify-end" />}
      {attachments.map((attachment, index) =>
        isImageLink(encodeURIComponent(attachment.name)) ? (
          <MessageImage
            key={index}
            src={encodeURIComponent(attachment.path)}
            alt={attachment.name}
            className="m-0 size-16"
          />
        ) : (
          <div
            key={index}
            className="flex h-16 w-28 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-secondary/50 text-foreground shadow-xs"
          >
            <div className="flex min-h-0 flex-1 items-center justify-center bg-background/70">
              <FileIcon path={attachment.name} className="size-6" />
            </div>
            <div
              className="flex h-6 shrink-0 items-center gap-1.5 bg-background/50 px-2 text-xs"
              title={attachment.name}
            >
              <FileIcon path={attachment.name} className="size-3.5" />
              <span className="min-w-0 truncate">{attachment.name}</span>
            </div>
          </div>
        ),
      )}
    </div>
  )
}
