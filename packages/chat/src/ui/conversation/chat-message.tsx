import { UserMessageContent } from './user-message-content'
import * as React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { Loader2 } from 'lucide-react'
import { ErrorLine } from '@pi-meme/ui/components/error-line'
import type { PiImage, PiMessage } from '@pi-meme/contracts/pi'
import type { ChatState } from '../model/types'
import { groupMessageParts } from '../model/message-parts'
import { useMarkdownComponents } from '../content/markdown-components'
import { AttachmentPreview } from '../content/attachment-preview'
import { ActivityGroup } from './activity-group'
import { cn } from '@pi-meme/ui/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { MessageActions } from './message-actions'
import { messageText } from '../model/message-text'
import type { MessageVersion } from '../model/message-versions'

export function ChatMessage({
  message,
  tools,
  live = false,
  className,
  onEdit,
  canEdit,
  onCopyError,
  versions,
  onSwitchVersion,
  versionSwitchBusy = false,
}: {
  message: PiMessage
  tools: ChatState['tools']
  live?: boolean
  className?: string
  onEdit?: (message: PiMessage) => void
  canEdit?: boolean
  onCopyError?: (message: string) => void
  versions?: MessageVersion[]
  onSwitchVersion?: (version: number) => void
  versionSwitchBusy?: boolean
}) {
  const markdownComponents = useMarkdownComponents()
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
        <div
          data-message-body=""
          className={cn(
            'text-sm text-foreground leading-relaxed',
            isUser
              ? 'rounded-2xl px-4 py-2.5 bg-[#183d6e] text-white whitespace-pre-wrap shadow-xs'
              : 'bg-transparent px-0 py-0.5 w-full',
          )}
        >
          {images.length > 0 && <AttachmentPreview images={images} />}

          {typeof content === 'string' ? (
            isUser ? (
              <UserMessageContent text={content} />
            ) : (
              <div className="pi-markdown">
                <Markdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeKatex]}
                  components={markdownComponents}
                >
                  {content}
                </Markdown>
              </div>
            )
          ) : segments ? (
            segments.map((seg, idx) => {
              if (seg.type === 'text') {
                if (isUser) return <UserMessageContent key={idx} text={seg.text} />
                return (
                  <div key={idx} className="pi-markdown">
                    <Markdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeKatex]}
                      components={markdownComponents}
                    >
                      {seg.text}
                    </Markdown>
                  </div>
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
        {isUser && (
          <div className="mt-1 flex h-7 items-center gap-1 text-sm text-muted-foreground/70 opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100">
            {typeof message.timestamp === 'number' && (
              <time className="mr-1 tabular-nums" dateTime={new Date(message.timestamp).toISOString()}>
                {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </time>
            )}
            {versions && versions.length > 1 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    data-testid="version-control"
                    aria-label="用户消息版本"
                    aria-busy={versionSwitchBusy}
                    className="flex items-center gap-0.5 rounded-full border border-border/80 bg-secondary/50 pl-1.5 pr-0.5 text-sm text-foreground/80"
                  >
                    <span className="select-none">版本</span>
                    <button
                      type="button"
                      disabled={!canEdit || versionSwitchBusy || versions.findIndex((version) => version.selected) <= 0}
                      onClick={() => onSwitchVersion?.(versions.findIndex((version) => version.selected) - 1)}
                      aria-label="查看上一个版本"
                      className="inline-flex size-5 items-center justify-center rounded-full hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
                    >
                      ‹
                    </button>
                    <span className="min-w-7 text-center tabular-nums">
                      {versionSwitchBusy ? (
                        <Loader2 aria-hidden="true" className="mx-auto size-3 animate-spin text-primary" />
                      ) : (
                        <>
                          {Math.max(
                            versions.findIndex((version) => version.selected),
                            0,
                          ) + 1}
                          /{versions.length}
                        </>
                      )}
                    </span>
                    <button
                      type="button"
                      disabled={
                        !canEdit ||
                        versionSwitchBusy ||
                        versions.findIndex((version) => version.selected) >= versions.length - 1
                      }
                      onClick={() => onSwitchVersion?.(versions.findIndex((version) => version.selected) + 1)}
                      aria-label="查看下一个版本"
                      className="inline-flex size-5 items-center justify-center rounded-full hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
                    >
                      ›
                    </button>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-sm">
                  切换版本会同时恢复该版本所属的完整后续对话
                </TooltipContent>
              </Tooltip>
            )}
            <MessageActions
              onCopy={() => navigator.clipboard.writeText(messageText(message))}
              onCopyError={onCopyError}
              canCopy={Boolean(messageText(message).trim())}
              onEdit={onEdit ? () => onEdit(message) : undefined}
              canEdit={Boolean(canEdit && typeof message.timestamp === 'number')}
            />
          </div>
        )}
      </div>
    </article>
  )
}
