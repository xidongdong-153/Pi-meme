import * as React from 'react'
import { PluginToolCard } from '@pi-meme/ui/components/plugin-tool-card'
import type { ActivityItem } from '../model/types'
import { cn } from '@pi-meme/ui/lib/utils'
import {
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  Images,
  Pencil,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import { extractDiff, extractImages, formatDetailValue, parseToolMeta } from '../model/tool-details'
import { runningActivityLabel } from '../model/activity-summary'
import { ToolDiff } from './tool-diff'

export function ToolActivityRow({
  item,
  open,
  onToggle,
  isLive = true,
  isPaused = false,
  isNested = true,
  className,
}: {
  item: Extract<ActivityItem, { type?: 'tool' }>
  open: boolean
  onToggle: () => void
  isLive?: boolean
  isPaused?: boolean
  isNested?: boolean
  className?: string
}) {
  const [copied, setCopied] = React.useState(false)
  const isRunning = isLive && item.status === 'running'
  const isError = item.status === 'error'

  const meta = parseToolMeta(item)
  const summary = isRunning && !isPaused ? runningActivityLabel([item]).replace(/…$/, '') : meta.summary
  const IconComponent = {
    command: SquareTerminal,
    read: BookOpen,
    write: Pencil,
    edit: Pencil,
    image: Images,
    search: Search,
    generic: Wrench,
    thinking: Sparkles,
  }[meta.kind]

  const diff = extractDiff(item.result)
  const images = extractImages(item.result)
  const script =
    item.name === 'codemode' &&
    item.args &&
    typeof item.args === 'object' &&
    'code' in item.args &&
    typeof item.args.code === 'string'
      ? item.args.code
      : undefined
  const rawText =
    item.output || (script && item.result === undefined ? '' : formatDetailValue(item.result ?? item.args))
  const hasDetail = Boolean(script || diff || images.length > 0 || rawText || item.children?.length || item.source)

  const handleCopy = React.useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      const textToCopy = diff || rawText
      if (!textToCopy) return
      try {
        await navigator.clipboard.writeText(textToCopy)
        setCopied(true)
        setTimeout(setCopied, 2000, false)
      } catch {
        // 忽略复制失败
      }
    },
    [diff, rawText],
  )

  return (
    <div className={cn('text-sm select-none', className)}>
      <div
        role="button"
        aria-label={`工具详情：${item.name ?? '未知工具'}`}
        aria-expanded={open}
        tabIndex={0}
        onClick={() => hasDetail && onToggle()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (hasDetail) onToggle()
          }
        }}
        title={meta.fullPath}
        className={cn(
          'group flex min-h-6 w-fit max-w-full items-center gap-2 py-0.5 pr-1 rounded leading-5 cursor-pointer transition-colors',
          'text-muted-foreground hover:text-foreground hover:bg-secondary/30',
          isNested && 'pl-2',
          !hasDetail && 'cursor-default',
        )}
      >
        {!isPaused && <IconComponent className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />}

        <span className={cn('truncate', isError && 'text-destructive')}>
          {isError ? summary.replace(/^已/u, '') : summary}
          {isError ? ' · 失败' : ''}
        </span>

        {hasDetail && (
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-300 ease-out ml-0.5',
              open ? 'rotate-0' : '-rotate-90',
            )}
          />
        )}
      </div>

      {hasDetail && (
        <div
          aria-hidden={!open}
          inert={!open}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-300 ease-out',
            open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="relative my-1 max-w-full rounded border border-border/40 bg-secondary/20 p-2 font-mono text-sm leading-relaxed text-muted-foreground select-text">
              <div className="flex items-center justify-between mb-1 pb-1 border-b border-border/30 font-sans text-muted-foreground/80">
                <span>{diff ? '变更内容 (Diff)' : isError ? '错误详情' : '输出内容'}</span>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1 px-1 py-0.5 rounded hover:bg-secondary/60 hover:text-foreground cursor-pointer"
                  title="复制输出"
                >
                  {copied ? (
                    <>
                      <Check className="size-2.5 text-emerald-500" />
                      <span className="text-emerald-500">已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy className="size-2.5" />
                      <span>复制</span>
                    </>
                  )}
                </button>
              </div>

              {script && (
                <>
                  <p className="mb-1">执行脚本</p>
                  <pre aria-label="codemode 执行脚本" className="mb-3 max-h-56 overflow-auto whitespace-pre-wrap">
                    {script}
                  </pre>
                </>
              )}
              {diff ? (
                <ToolDiff diff={diff} />
              ) : rawText ? (
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap">{rawText}</pre>
              ) : null}

              {item.children?.map((child) => (
                <NestedToolActivity key={child.id} tool={child} isLive={isLive} isPaused={isPaused} />
              ))}
              {images.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {images.map((img, i) => (
                    <img
                      key={i}
                      src={`data:${img.mimeType};base64,${img.data}`}
                      alt="工具输出图片"
                      className="max-h-60 max-w-full rounded border border-border/40 object-contain"
                    />
                  ))}
                </div>
              )}
              {!isError && <PluginToolCard tool={item} {...item.source} />}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function NestedToolActivity({
  tool,
  isLive,
  isPaused,
}: {
  tool: import('../model/types').ToolRun
  isLive: boolean
  isPaused: boolean
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <div className="mt-1 border-l border-border/40 pl-2" data-parent-tool={tool.parentToolCallId}>
      <ToolActivityRow
        item={tool}
        open={open}
        onToggle={() => setOpen(!open)}
        isLive={isLive}
        isPaused={isPaused}
        isNested
      />
    </div>
  )
}
