import type { TaskMode, QueuedInput } from '@pi-meme/contracts/plan'
import * as React from 'react'
import type { ClipboardEvent, DragEvent, ReactNode } from 'react'
import type { ChatBridge } from '@pi-meme/contracts/desktop'
import type { PiSlashCommand, PiState } from '@pi-meme/contracts/pi'
import type { ChatState } from '../model/types'
import { cn } from '@pi-meme/ui/lib/utils'
import type { ComposerAttachment } from './image-attachment'
import { useComposerFiles } from './use-composer-files'
import { ComposerEditor } from './composer-editor'
import { ComposerToolbar } from './composer-toolbar'
import { ComposerAttachments } from './composer-attachments'
import { ComposerQueues } from './composer-queues'

export type AgentPluginOption = {
  id: string
  name: string
  description?: string
  iconUrl?: string
}

export type ComposerAgentPlugins = {
  options: AgentPluginOption[]
  selected: AgentPluginOption[]
  mentions: AgentPluginOption[]
  select: (id: string) => Promise<boolean>
  loading: boolean
  saving: boolean
  disabledReason?: string
  change: (ids: string[]) => Promise<boolean>
}

export type ComposerProps = {
  compact?: boolean
  mode?: TaskMode
  onMode?: (mode: TaskMode) => void
  onPlanCommand?: (text: string) => void
  onGoalCommand?: (text: string) => void
  goalControl?: ReactNode
  goalBanner?: ReactNode
  recoveredInputs?: QueuedInput[]
  onRestoreQueuedInput?: (input: QueuedInput) => void
  sessionKey?: string
  attachmentContextKey?: string
  uploadAttachment: ChatBridge['uploadAttachment']
  projectPath?: string
  loadProjectFiles?: ChatBridge['getProjectFiles']
  selectedSkills: PiSlashCommand[]
  onSkills: (skills: PiSlashCommand[]) => void
  agentPlugins?: ComposerAgentPlugins
  draft: string
  onDraft: (value: string) => void
  /** 空草稿时显示的下一步提示。Tab 填入草稿，不发送。 */
  hint?: string
  onAcceptHint?: () => void
  onDismissHint?: () => void
  attachments: ComposerAttachment[]
  onAddImages: (images: ComposerAttachment[]) => void
  onRemoveImage: (id: string) => void
  paused?: boolean
  activeMode?: TaskMode
  editingQueue?: boolean
  onResume?: () => void
  onSteerQueueInput?: (id: string) => void
  onDeleteQueueInput?: (id: string) => void
  onEditQueueInput?: (id: string) => void
  running: boolean
  disabled: boolean
  queueMode: 'steering' | 'followUp'
  onQueueMode: (mode: 'steering' | 'followUp') => void
  steeringMode?: PiState['steeringMode']
  followUpMode?: PiState['followUpMode']
  onSteeringMode: (mode: PiState['steeringMode']) => void
  onFollowUpMode: (mode: PiState['followUpMode']) => void
  queues: Pick<ChatState, 'steering' | 'followUp'>
  onSend: () => void
  onStop: () => void
  onClearQueue: () => void
  commands: PiSlashCommand[]
  /** 扩展挂件、状态与占用展示由 desktop 组合后作为节点传入 */
  widgetsAbove: ReactNode
  widgetsBelow: ReactNode
  statusBadges: ReactNode
  focusVersion: number
  onError: (message: string) => void
  model: ReactNode
  access: ReactNode
  contextUsage: ReactNode
  editing: boolean
  onCancelEdit: () => void
}

export function Composer({
  compact,
  mode,
  onMode,
  onPlanCommand,
  onGoalCommand,
  goalControl,
  goalBanner,
  recoveredInputs,
  onRestoreQueuedInput,
  sessionKey,
  attachmentContextKey,
  uploadAttachment,
  projectPath,
  loadProjectFiles,
  selectedSkills,
  onSkills,
  agentPlugins,
  draft,
  onDraft,
  hint,
  onAcceptHint,
  onDismissHint,
  attachments,
  onAddImages,
  onRemoveImage,
  running,
  paused,
  activeMode,
  editingQueue,
  onResume,
  onSteerQueueInput,
  onDeleteQueueInput,
  onEditQueueInput,
  disabled,
  queueMode,
  onQueueMode,
  steeringMode,
  followUpMode,
  onSteeringMode,
  onFollowUpMode,
  queues,
  onSend,
  onStop,
  onClearQueue,
  commands,
  widgetsAbove,
  widgetsBelow,
  statusBadges,
  focusVersion,
  onError,
  model,
  access,
  contextUsage,
  editing,
  onCancelEdit,
}: ComposerProps) {
  const [dragging, setDragging] = React.useState(false)
  const files = useComposerFiles({
    contextKey: JSON.stringify([attachmentContextKey, editing, editingQueue]),
    sessionKey,
    disabled,
    uploadAttachment,
    onAdd: onAddImages,
    onError,
  })
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const hasQueue = queues.steering.length > 0 || queues.followUp.length > 0

  function cancelEdit() {
    files.cancel()
    onCancelEdit()
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
    setDragging(false)
    void files.addFiles(Array.from(event.dataTransfer.files))
  }

  return (
    <>
      <ComposerQueues
        {...{ queues, paused, activeMode, disabled, onResume, onSteerQueueInput, onDeleteQueueInput, onEditQueueInput }}
      />
      {goalBanner}
      <form
        aria-label="消息输入"
        className={cn(
          'composer @container relative flex flex-col rounded-[20px] p-3 shadow-md transition-colors',
          compact && 'composer-compact',
          dragging && 'ring-2 ring-primary/40',
        )}
        style={{ backgroundColor: 'color-mix(in srgb, var(--background), var(--foreground) 11%)' }}
        onSubmit={(event) => {
          event.preventDefault()
          if (
            !disabled &&
            !files.isUploading() &&
            !agentPlugins?.saving &&
            (draft.trim() || selectedSkills.length || attachments.length)
          )
            onSend()
        }}
        onDragEnter={(event) => {
          if (!disabled && event.dataTransfer.types.includes('Files')) setDragging(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }}
        onDrop={drop}
      >
        {/* 隐藏的附件文件选择器 */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          disabled={disabled}
          className="hidden"
          onChange={(event) => {
            if (event.target.files?.length) {
              void files.addFiles(Array.from(event.target.files))
              event.target.value = ''
            }
          }}
        />

        {widgetsAbove}
        {statusBadges}

        {(editing || editingQueue) && (
          <div className="mb-2 flex items-center justify-between rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
            <span className="text-foreground">{editingQueue ? '正在编辑排队消息' : '正在编辑历史消息'}</span>
            <button
              type="button"
              disabled={disabled}
              onClick={cancelEdit}
              className="rounded px-2 py-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              取消编辑
            </button>
          </div>
        )}

        {recoveredInputs?.map((input) => (
          <button
            key={input.id}
            type="button"
            className="mb-1 rounded border border-border p-2 text-left text-xs"
            onClick={() => {
              files.cancel()
              onRestoreQueuedInput?.(input)
            }}
          >
            恢复{input.mode === 'plan' ? '计划' : ''}草稿：{input.text || '图片消息'}
            {input.images?.length ? `（${input.images.length} 张图片）` : ''}
          </button>
        ))}
        <ComposerAttachments
          attachments={attachments}
          onRemoveImage={onRemoveImage}
          disabled={disabled}
          uploads={files.uploads}
          onCancelUpload={files.cancelUpload}
        />
        {files.uploading && (
          <p role="status" className="mb-2 text-xs text-muted-foreground">
            正在添加附件（剩余 {files.pending} 个）…
          </p>
        )}
        <div className="composer-layout">
          <ComposerEditor
            disabled={disabled}
            sessionKey={sessionKey}
            agentPlugins={agentPlugins}
            onPlanCommand={onPlanCommand}
            onGoalCommand={onGoalCommand}
            projectPath={projectPath}
            loadProjectFiles={loadProjectFiles}
            selectedSkills={selectedSkills}
            onSkills={onSkills}
            draft={draft}
            onDraft={onDraft}
            hint={hint}
            onAcceptHint={onAcceptHint}
            onDismissHint={onDismissHint}
            commands={commands}
            focusVersion={focusVersion}
            onClearQueue={onClearQueue}
            hasQueue={hasQueue}
            onEscape={cancelEdit}
            paste={paste}
            dragging={dragging}
          />
          <div className="composer-below">{widgetsBelow}</div>
          <ComposerToolbar
            compact={compact}
            goalControl={goalControl}
            mode={mode}
            onMode={onMode}
            running={running}
            paused={paused}
            editingQueue={editingQueue}
            onResume={onResume}
            disabled={disabled}
            sendDisabled={agentPlugins?.saving || (files.uploading && !running && !paused)}
            draft={files.uploading ? '' : draft}
            hasAttachments={!files.uploading && (attachments.length > 0 || selectedSkills.length > 0)}
            queueMode={queueMode}
            onQueueMode={onQueueMode}
            steeringMode={steeringMode}
            followUpMode={followUpMode}
            onSteeringMode={onSteeringMode}
            onFollowUpMode={onFollowUpMode}
            onStop={onStop}
            onAddFiles={() => fileInputRef.current?.click()}
            model={model}
            access={access}
            contextUsage={contextUsage}
            editing={editing}
          />
        </div>
      </form>
    </>
  )
}
