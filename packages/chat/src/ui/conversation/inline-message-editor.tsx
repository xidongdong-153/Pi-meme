import { useEffect, useRef } from 'react'
import type { ClipboardEvent, DragEvent, ReactNode } from 'react'
import { Plus } from 'lucide-react'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import type { ComposerProps } from '../composer/composer'
import type { ComposerAttachment } from '../composer/image-attachment'
import { useComposerFiles } from '../composer/use-composer-files'
import { ComposerEditor } from '../composer/composer-editor'
import { ComposerAttachments } from '../composer/composer-attachments'
import { cn } from '@pi-meme/ui/lib/utils'

/** 原位置编辑用户历史消息所需的状态与操作，由 desktop 从 useChatSession 装配。 */
export type MessageEditorState = Pick<
  ComposerProps,
  | 'projectPath'
  | 'loadProjectFiles'
  | 'sessionKey'
  | 'uploadAttachment'
  | 'onError'
  | 'composerStore'
  | 'files'
  | 'agentPlugins'
> & {
  entryId: string
  model?: ReactNode
  submitting?: boolean
  submissionLabel?: string
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
  const fileInputRef = useRef<HTMLInputElement>(null)
  const ownedFiles = useComposerFiles({
    contextKey: editor.entryId,
    sessionKey: editor.sessionKey,
    disabled: editor.disabled || Boolean(editor.files),
    uploadAttachment: editor.uploadAttachment,
    onAdd: editor.onAddImages,
    onError: editor.onError,
  })
  const files = editor.files ?? ownedFiles
  const canSubmit =
    !editor.disabled && !files.uploading && (Boolean(editor.draft.trim()) || editor.attachments.length > 0)

  useEffect(() => {
    containerRef.current?.querySelector<HTMLElement>('[contenteditable=true][aria-label="消息"]')?.focus()
  }, [])

  function cancelEdit() {
    if (editor.submitting) return
    files.cancel()
    editor.onCancel()
  }

  function paste(event: ClipboardEvent<HTMLDivElement>) {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (!images.length) return
    event.preventDefault()
    void files.addFiles(images)
  }

  function drop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault()
    void files.addFiles(Array.from(event.dataTransfer.files))
  }

  return (
    <article
      ref={containerRef}
      data-testid="inline-message-editor"
      aria-label="编辑历史消息"
      className="w-full py-1 text-sm"
    >
      <form
        className="@container flex w-full flex-col rounded-2xl border border-border/80 bg-card/95 p-3 shadow-sm transition-all focus-within:border-border"
        onSubmit={(event) => {
          event.preventDefault()
          if (canSubmit && !files.isUploading()) editor.onSubmit()
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }}
        onDrop={drop}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          disabled={editor.disabled}
          className="hidden"
          onChange={(event) => {
            if (event.target.files?.length) {
              void files.addFiles(Array.from(event.target.files))
              event.target.value = ''
            }
          }}
        />
        <ComposerAttachments
          attachments={editor.attachments}
          onRemoveImage={editor.onRemoveImage}
          disabled={editor.disabled}
          uploads={files.uploads}
          onCancelUpload={files.cancelUpload}
        />
        {files.uploading && (
          <p role="status" className="mb-2 text-xs text-muted-foreground">
            正在添加附件（剩余 {files.pending} 个）…
          </p>
        )}
        <ComposerEditor
          composerStore={editor.composerStore}
          disabled={editor.disabled}
          sessionKey={editor.sessionKey}
          agentPlugins={editor.agentPlugins}
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
          onEscape={cancelEdit}
          editing={true}
        />

        {editor.submitting && (
          <p className="mt-2 text-xs text-muted-foreground" role="status">
            {editor.submissionLabel}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            disabled={editor.disabled}
            onClick={() => fileInputRef.current?.click()}
            aria-label="添加附件"
            className="mr-auto inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="size-4" />
          </button>
          <div className="min-w-0 max-w-[220px]">{editor.model}</div>
          <button
            type="button"
            disabled={editor.submitting}
            data-testid="inline-edit-cancel"
            onClick={cancelEdit}
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
