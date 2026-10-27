import type { BrowserAnnotation } from '@pi-meme/contracts/browser'
import { parseAnnotations } from '@pi-meme/contracts/browser-annotations'
import { UserMessageContent } from './user-message-content'
import { UserMessageAttachments } from './user-message-attachments'
import { messageAttachmentParts } from '../model/message-attachments'
import * as React from 'react'
import { ErrorLine } from '@pi-meme/ui/components/error-line'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { MessageSquare } from 'lucide-react'
import type { PiImage, PiMessage } from '@pi-meme/contracts/pi'
import type { ChatState } from '../model/types'
import { groupMessageParts } from '../model/message-parts'
import { MarkdownContent } from '../content/markdown-content'
import { AttachmentPreview } from '../content/attachment-preview'
import { ActivityGroup } from './activity-group'
import { cn } from '@pi-meme/ui/lib/utils'
import { MessageActions } from './message-actions'
import { MessageTime } from './message-time'
import { messageText } from '../model/message-text'
import { PluginMessageActions } from '@pi-meme/ui/components/plugin-message-actions'

export function ChatMessage({
  message,
  tools,
  live = false,
  className,
  onEdit,
  canEdit,
  onCopyError,
}: {
  message: PiMessage
  tools: ChatState['tools']
  live?: boolean
  className?: string
  onEdit?: (message: PiMessage) => void
  canEdit?: boolean
  onCopyError?: (message: string) => void
}) {
  const content = 'content' in message ? message.content : undefined
  const segments = React.useMemo(
    () => (Array.isArray(content) ? groupMessageParts(content, tools, live) : null),
    [content, tools, live],
  )
  if (!message || message.role === 'toolResult' || message.role === 'system') return null

  // 独立的 bash 执行消息
  if (message.role === 'bashExecution') {
    return (
      <div className={cn('w-full py-0.5', className)}>
        <ActivityGroup
          items={[
            {
              id: String(message.timestamp || 'bash'),
              type: 'tool',
              name: 'bash',
              command: message.command,
              output: message.output,
              status:
                !message.cancelled && typeof message.exitCode === 'number' && message.exitCode !== 0
                  ? 'error'
                  : 'success',
            },
          ]}
        />
      </div>
    )
  }

  const isUser = message.role === 'user'
  const userContent = isUser
    ? messageAttachmentParts(
        typeof content === 'string'
          ? content
          : (segments?.flatMap((segment) => (segment.type === 'text' ? [segment.text] : [])).join('') ?? ''),
      )
    : null

  // 提取消息中的图片
  const images: Array<PiImage & { id?: string }> = []
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'image' && part.data) {
        images.push({
          type: 'image',
          data: part.data,
          mimeType: part.mimeType || 'image/png',
          id: 'id' in part && typeof part.id === 'string' ? part.id : undefined,
        })
      }
    }
  }

  const browserContent = userContent ? parseAnnotations(userContent.text, images) : undefined

  return (
    <article
      data-message-role={message.role}
      className={cn(
        'group/message flex w-full py-1 text-sm select-text transition-all',
        isUser ? 'justify-end' : 'justify-start',
        className,
      )}
    >
      <div className={cn('flex flex-col min-w-0', isUser ? 'max-w-[85%] items-end' : 'w-full items-start')}>
        {userContent && <UserMessageAttachments attachments={userContent.attachments} images={images} />}
        {browserContent?.annotations.length ? (
          <MessageAnnotationSummary annotations={browserContent.annotations} />
        ) : null}
        {(!userContent || (browserContent?.text ?? userContent.text)) && (
          <div
            data-message-body=""
            className={cn(
              'text-sm text-foreground leading-relaxed',
              isUser
                ? 'rounded-2xl px-4 py-2.5 bg-[#183d6e] text-white whitespace-pre-wrap shadow-xs'
                : 'bg-transparent px-0 py-0.5 w-full',
            )}
          >
            {!isUser && images.length > 0 && <AttachmentPreview images={images} />}

            {userContent ? (
              <UserMessageContent text={browserContent?.text ?? userContent.text} />
            ) : typeof content === 'string' ? (
              <MarkdownContent isStreaming={live}>{content}</MarkdownContent>
            ) : segments ? (
              segments.map((seg, idx) => {
                if (seg.type === 'text') {
                  return (
                    <MarkdownContent key={idx} isStreaming={live}>
                      {seg.text}
                    </MarkdownContent>
                  )
                }
                if (seg.type === 'activity') {
                  return <ActivityGroup key={idx} items={seg.items} isLive={live} />
                }
                return null
              })
            ) : null}

            {message.role === 'assistant' && message.stopReason !== 'aborted' && message.errorMessage && (
              <ErrorLine className="mt-2" message={message.role === 'assistant' ? message.errorMessage! : ''} />
            )}
          </div>
        )}
        {isUser && (
          <div className="mt-1 flex h-7 items-center gap-1 text-sm text-muted-foreground/70 opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100">
            <MessageActions
              onCopy={() => navigator.clipboard.writeText(messageText(message))}
              onCopyError={onCopyError}
              canCopy={Boolean(messageText(message).trim())}
              onEdit={onEdit ? () => onEdit(message) : undefined}
              canEdit={Boolean(canEdit && message.sourceEntry)}
            />
            <PluginMessageActions
              role="user"
              entries={message.sourceEntry ? [message.sourceEntry] : []}
              displayedText={messageText(message)}
              state={live ? 'streaming' : 'complete'}
              source={message.source}
            />
            <MessageTime timestamp={message.timestamp} />
          </div>
        )}
      </div>
    </article>
  )
}

function MessageAnnotationSummary({ annotations }: { annotations: BrowserAnnotation[] }) {
  const [open, setOpen] = React.useState(false)
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hoverOpened = React.useRef(false)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const clearHoverTimer = () => clearTimeout(hoverTimer.current)
  React.useEffect(() => () => clearTimeout(hoverTimer.current), [])
  const scheduleClose = () => {
    clearHoverTimer()
    hoverTimer.current = setTimeout(() => {
      if (!contentRef.current?.contains(document.activeElement)) setOpen(false)
    }, 250)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        clearHoverTimer()
        if (value) hoverOpened.current = false
        setOpen(value)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`查看 ${annotations.length} 条批注`}
          className="mb-2 inline-flex h-8 max-w-full items-center gap-1.5 rounded-xl border border-border bg-secondary/50 px-2.5 text-xs text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerEnter={(event) => {
            if (event.pointerType !== 'mouse') return
            clearHoverTimer()
            if (open) return
            hoverTimer.current = setTimeout(() => {
              hoverOpened.current = true
              setOpen(true)
            }, 150)
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse') scheduleClose()
          }}
        >
          <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="whitespace-nowrap">{annotations.length} 条注释</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        aria-label="批注详情"
        side="top"
        align="end"
        className="max-h-[min(20rem,var(--radix-popover-content-available-height))] w-[min(350px,calc(100vw-32px))] overflow-y-auto p-1.5"
        onPointerEnter={clearHoverTimer}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') scheduleClose()
        }}
        onOpenAutoFocus={(event) => {
          if (hoverOpened.current) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          if (hoverOpened.current) event.preventDefault()
          hoverOpened.current = false
        }}
      >
        <div className="divide-y divide-border/70">
          {annotations.map((annotation) => (
            <div key={annotation.id} className="px-2.5 py-3">
              <span className="rounded-md border border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                {annotation.tag || '区域'}
              </span>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm">{annotation.comment || '分析选中的元素'}</p>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
