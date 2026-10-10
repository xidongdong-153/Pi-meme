import * as React from 'react'
import { ChevronRight, Copy, Check, Target, CheckCircle2, FileEdit, FileText } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { cn } from '@pi-meme/ui/lib/utils'
import { MarkdownContent } from '../content/markdown-content'
import { parseCompactionSummary } from '../model/compaction-parser'

export type CompactionCardProps = {
  kind: 'compaction' | 'branch_summary'
  summary: string
  tokensBefore?: number
  timestamp?: number
}

function formatTokens(tokens?: number): string {
  if (!tokens || tokens <= 0) return ''
  if (tokens >= 10000) return `${Math.round(tokens / 1000)}k`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return `${tokens}`
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** 压缩专用行内图标 [=] */
export function CompactionIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-3.5 shrink-0', className)}
      aria-hidden="true"
    >
      <path d="M4.5 3.5H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1.5" />
      <path d="M11.5 3.5H13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-1.5" />
      <line x1="5.5" y1="6.5" x2="10.5" y2="6.5" />
      <line x1="5.5" y1="9.5" x2="10.5" y2="9.5" />
    </svg>
  )
}

/**
 * 压缩完成后的文本行（非卡片式）：
 * 默认显示：[=] 上下文已压缩
 * 点击整行可展开详情信息。
 */
export const CompactionCard = React.memo(({ kind, summary, tokensBefore, timestamp }: CompactionCardProps) => {
  const [expanded, setExpanded] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [copiedPath, setCopiedPath] = React.useState<string | null>(null)

  const parsed = React.useMemo(() => parseCompactionSummary(summary), [summary])
  const tokenLabel = formatTokens(tokensBefore)
  const timeLabel = formatTime(timestamp)
  const isBranch = kind === 'branch_summary'

  const handleCopySummary = React.useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      try {
        await navigator.clipboard.writeText(summary)
        setCopied(true)
        setTimeout(setCopied, 1500, false)
      } catch {
        // 忽略剪贴板写入失败
      }
    },
    [summary],
  )

  const handleCopyPath = React.useCallback(async (path: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(path)
      setCopiedPath(path)
      setTimeout(setCopiedPath, 1200, null)
    } catch {
      // 忽略剪贴板写入失败
    }
  }, [])

  return (
    <div className="my-1.5 text-xs" aria-label={isBranch ? '分支上下文汇总' : '上下文已压缩'}>
      {/* 文本行（参考设计图：[=] 上下文已压缩） */}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="group inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer select-none text-left"
        aria-expanded={expanded}
      >
        <CompactionIcon className="text-muted-foreground group-hover:text-foreground transition-colors" />
        <span className="font-medium text-foreground/90 group-hover:text-foreground">
          {isBranch ? '分支上下文已压缩' : '上下文已压缩'}
        </span>
        <ChevronRight
          className={cn(
            'size-3 text-muted-foreground/50 group-hover:text-muted-foreground transition-transform duration-200',
            expanded && 'rotate-90',
          )}
        />
      </button>

      {/* 点开文本行展开的详情信息面板（限制最大高度，可内部滚动） */}
      {expanded && (
        <div className="mt-2 mb-2 ml-1.5 pl-3.5 pr-2 border-l border-border/40 max-h-72 overflow-y-auto overscroll-contain space-y-3 select-text animate-in fade-in slide-in-from-top-1 duration-200">
          {/* 状态指标条与复制（吸顶可见） */}
          <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-background/95 py-0.5 backdrop-blur-xs text-muted-foreground/80">
            <div className="flex items-center gap-2.5 flex-wrap font-mono text-[11px]">
              {tokenLabel && <span>原上下文 ~{tokenLabel} Tokens</span>}
              {timeLabel && <span className="text-muted-foreground/50">{timeLabel}</span>}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={handleCopySummary}
              className="size-6 rounded text-muted-foreground hover:text-foreground cursor-pointer"
              title="复制完整摘要"
              aria-label="复制完整摘要"
            >
              {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
            </Button>
          </div>

          {parsed.isStructured ? (
            <>
              {parsed.goal && (
                <div className="space-y-1">
                  <div className="font-medium text-foreground/85 flex items-center gap-1.5">
                    <Target className="size-3 text-primary/80" />
                    <span>核心目标</span>
                  </div>
                  <div className="text-muted-foreground leading-relaxed pl-4">
                    <MarkdownContent>{parsed.goal}</MarkdownContent>
                  </div>
                </div>
              )}

              {parsed.progress && (
                <div className="space-y-1">
                  <div className="font-medium text-foreground/85 flex items-center gap-1.5">
                    <CheckCircle2 className="size-3 text-emerald-500/80" />
                    <span>最新进展</span>
                  </div>
                  <div className="text-muted-foreground leading-relaxed pl-4">
                    <MarkdownContent>{parsed.progress}</MarkdownContent>
                  </div>
                </div>
              )}

              {/* 涉及文件 */}
              {(parsed.modifiedFiles.length > 0 || parsed.readFiles.length > 0) && (
                <div className="space-y-2 pt-0.5">
                  {parsed.modifiedFiles.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[11px] text-muted-foreground/80 flex items-center gap-1 font-medium">
                        <FileEdit className="size-3 text-amber-500/80" />
                        <span>修改的文件（{parsed.modifiedFiles.length}）</span>
                      </div>
                      <div className="flex flex-col gap-0.5 pl-4">
                        {parsed.modifiedFiles.map((file) => (
                          <button
                            key={file}
                            type="button"
                            onClick={(e) => handleCopyPath(file, e)}
                            className="group/file text-left font-mono text-[11px] text-muted-foreground hover:text-foreground truncate transition-colors cursor-pointer py-0.5"
                            title="点击复制路径"
                          >
                            <span className="truncate">{file}</span>
                            <span className="opacity-0 group-hover/file:opacity-100 text-[10px] text-muted-foreground/60 ml-2">
                              {copiedPath === file ? '已复制' : '复制'}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {parsed.readFiles.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[11px] text-muted-foreground/80 flex items-center gap-1 font-medium">
                        <FileText className="size-3 text-blue-500/80" />
                        <span>读取的文件（{parsed.readFiles.length}）</span>
                      </div>
                      <div className="flex flex-col gap-0.5 pl-4">
                        {parsed.readFiles.map((file) => (
                          <button
                            key={file}
                            type="button"
                            onClick={(e) => handleCopyPath(file, e)}
                            className="group/file text-left font-mono text-[11px] text-muted-foreground hover:text-foreground truncate transition-colors cursor-pointer py-0.5"
                            title="点击复制路径"
                          >
                            <span className="truncate">{file}</span>
                            <span className="opacity-0 group-hover/file:opacity-100 text-[10px] text-muted-foreground/60 ml-2">
                              {copiedPath === file ? '已复制' : '复制'}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {parsed.detailsMarkdown && (
                <div className="pt-0.5 text-muted-foreground leading-relaxed pl-4">
                  <MarkdownContent>{parsed.detailsMarkdown}</MarkdownContent>
                </div>
              )}
            </>
          ) : (
            <div className="text-muted-foreground leading-relaxed pl-4">
              <MarkdownContent>{summary}</MarkdownContent>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

/**
 * 压缩中的文本行（非卡片式，参考设计图：[=] 正在压缩上下文）
 */
export const CompactionProgressCard = React.memo(() => {
  return (
    <div
      className="my-1.5 flex items-center gap-2 text-xs text-muted-foreground select-none animate-in fade-in duration-200"
      aria-live="polite"
    >
      <CompactionIcon className="text-muted-foreground animate-pulse" />
      <span>正在压缩上下文</span>
    </div>
  )
})
