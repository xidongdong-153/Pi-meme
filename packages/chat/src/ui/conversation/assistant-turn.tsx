import { AlertCircle, Loader2 } from 'lucide-react'
import type { TurnChunk } from '../model/types'
import { AttachmentPreview } from '../content/attachment-preview'
import { MarkdownContent } from '../content/markdown-content'
import { ActivityGroup } from './activity-group'
import { cn } from '@pi-meme/ui/lib/utils'
import { MessageActions } from './message-actions'

export function AssistantTurnView({
  turn,
  className,
  canFork,
  onFork,
  onCopyError,
}: {
  turn: Extract<TurnChunk, { type: 'assistant_turn' }>
  className?: string
  canFork?: boolean
  onFork?: (timestamp: number) => void
  onCopyError?: (message: string) => void
}) {
  return (
    <article
      data-message-role="assistant"
      className={cn('group flex w-full py-1 text-sm select-text transition-all justify-start', className)}
    >
      <div className="flex flex-col min-w-0 w-full items-start">
        <div className="text-sm text-foreground leading-relaxed bg-transparent px-0 py-0.5 w-full">
          {/* 1. 本轮工作过程（思考与所有工具调用统一内聚于此） */}
          {turn.activities.length > 0 && (
            <ActivityGroup
              items={turn.activities}
              isLive={turn.isLive}
              durationMs={turn.durationMs}
              startedAt={turn.startedAt}
            />
          )}

          {/* 2. 图片展示 */}
          {turn.images.length > 0 && <AttachmentPreview images={turn.images} />}

          {/* 3. 本轮最终正文 Markdown */}
          {turn.finalText ? <MarkdownContent>{turn.finalText}</MarkdownContent> : null}

          {/* 4. 如果正在生成且暂无任何内容输出，展示分析准备指示 */}
          {turn.isLive && !turn.finalText && turn.activities.length === 0 && (
            <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground animate-pulse">
              <Loader2 className="size-3.5 animate-spin text-primary" />
              <span>Pi 正在分析并准备回复…</span>
            </div>
          )}

          {/* 5. 错误提示 */}
          {turn.errorMessage && (
            <div
              role="alert"
              className="mt-2.5 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
            >
              <AlertCircle className="size-4 shrink-0 mt-0.5" />
              <div className="font-medium whitespace-pre-wrap leading-relaxed">{turn.errorMessage}</div>
            </div>
          )}
        </div>
        <div className="mt-1 flex h-7 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <MessageActions
            onCopy={() => navigator.clipboard.writeText(turn.finalText)}
            onCopyError={onCopyError}
            canCopy={Boolean(turn.finalText.trim())}
            canEdit={false}
            onFork={onFork && typeof turn.startedAt === 'number' ? () => onFork(turn.startedAt!) : undefined}
            canFork={Boolean(canFork && !turn.isLive && typeof turn.startedAt === 'number')}
          />
        </div>
      </div>
    </article>
  )
}
