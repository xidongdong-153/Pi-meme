import { useEffect, useRef } from 'react'
import type { ClipboardEvent, DragEvent } from 'react'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import type { ComposerProps } from '../composer/composer'
import type { ComposerAttachment } from '../composer/image-attachment'
import { imageToAttachment } from '../composer/image-attachment'
import { ComposerEditor } from '../composer/composer-editor'
import { ComposerAttachments } from '../composer/composer-attachments'
import { cn } from '@pi-meme/ui/lib/utils'

/** 原位置编辑用户历史消息所需的状态与操作，由 desktop 从 useChatSession 装配。 */
export type MessageEditorState = Pick<ComposerProps, 'projectPath' | 'loadProjectFiles'> & {
  timestamp: number
  draft: string
  onDraft: (value: string) => void
  selectedSkills: PiSlashCommand[]
  onSkills: (skills: PiSlashCommand[]) => void
  attachments: ComposerAttachment[]
  onAddImages: (images: ComposerAttachment[]) => void
  onRemoveImage: (id: string) => void
  commands: PiSlashCommand[]
  focusVersion: number
  disabled: boolean
  onSubmit: () => void
  onCancel: () => void
}

/**
 * 在被编辑的用户消息原位置展示编辑器，保持简洁输入框与附件能力。
 */
export function InlineMessageEditor({ editor }: { editor: MessageEditorState }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canSubmit = !editor.disabled && (Boolean(editor.draft.trim()) || editor.attachments.length > 0)

  useEffect(() => {
    containerRef.current?.querySelector<HTMLElement>('[contenteditable=true][aria-label="消息"]')?.focus()
  }, [])

  async function addFiles(files: File[]) {
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (!images.length) return
    const results = await Promise.allSettled(images.map(imageToAttachment))
    const ready = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    if (ready.length) editor.onAddImages(ready)
  }

  function paste(event: ClipboardEvent<HTMLDivElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (!files.length) return
    event.preventDefault()
    void addFiles(files)
  }

  function drop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault()
    void addFiles(Array.from(event.dataTransfer.files))
  }

  return (
    <article
      ref={containerRef}
      data-testid="inline-message-editor"
      aria-label="编辑历史消息"
      className="w-full py-1 text-sm"
    >
      <form
        className="flex w-full flex-col rounded-2xl border border-border/80 bg-card/95 p-3 shadow-sm transition-all focus-within:border-border"
        onSubmit={(event) => {
          event.preventDefault()
          if (canSubmit) editor.onSubmit()
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }}
        onDrop={drop}
      >
        <ComposerAttachments attachments={editor.attachments} onRemoveImage={editor.onRemoveImage} />
        <ComposerEditor
          projectPath={editor.projectPath}
          loadProjectFiles={editor.loadProjectFiles}
          selectedSkills={editor.selectedSkills}
          onSkills={editor.onSkills}
          draft={editor.draft}
          onDraft={editor.onDraft}
          commands={editor.commands}
          focusVersion={editor.focusVersion}
          onClearQueue={() => {}}
          hasQueue={false}
          paste={paste}
          dragging={false}
          onEscape={editor.onCancel}
        />

        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="inline-edit-cancel"
            onClick={editor.onCancel}
            aria-label="取消编辑用户消息"
            className="rounded-lg bg-secondary/80 px-3 py-1 text-sm text-foreground/80 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            取消
          </button>
          <button
            type="submit"
            data-testid="inline-edit-submit"
            disabled={!canSubmit}
            aria-label="发送编辑后的消息"
            className={cn(
              'rounded-lg bg-foreground px-3.5 py-1 text-sm font-medium text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              !canSubmit && 'cursor-not-allowed opacity-40 hover:bg-foreground',
            )}
          >
            发送
          </button>
        </div>
      </form>
    </article>
  )
}
