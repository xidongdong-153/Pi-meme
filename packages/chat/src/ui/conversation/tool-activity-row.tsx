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
import { ImageThumbnail } from '../content/message-image'
import { imageSource } from '../content/image-viewer'

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
  const hasDetail =
    meta.kind !== 'read' &&
    meta.kind !== 'edit' &&
    Boolean(script || diff || images.length > 0 || rawText || item.children?.length || item.source)

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

  const imagePreviews = images.length > 0 && (
    <div className={cn('flex flex-wrap', isNested && 'pl-2')}>
      {images.map((image, index) => (
        <ImageThumbnail
          key={index}
          src={imageSource({ type: 'image', ...image })}
          label="工具输出图片"
          filename={meta.fullPath?.split(/[\\/]/).pop() || `image-${index + 1}`}
          remote={false}
        />
      ))}
    </div>
  )
  if (
    images.length > 0 &&
    (meta.kind === 'image' || !rawText) &&
    !isError &&
    !script &&
    !diff &&
    !item.children?.length &&
    !item.source
  )
    return <div className={className}>{imagePreviews}</div>

  return (
    <div className={cn('text-xs select-none', className)}>
      <div
        role={hasDetail ? 'button' : undefined}
        aria-label={hasDetail ? `工具详情：${item.name ?? '未知工具'}` : undefined}
        aria-expanded={hasDetail ? open : undefined}
        tabIndex={hasDetail ? 0 : undefined}
        onClick={() => hasDetail && onToggle()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (hasDetail) onToggle()
          }
        }}
        title={meta.fullPath}
        className={cn(
          'group/tool-toggle flex min-h-6 w-fit max-w-full items-center gap-2 py-0.5 pr-1 rounded leading-5 cursor-pointer transition-colors',
          'text-muted-foreground hover:text-foreground',
          isNested && 'pl-2',
          !hasDetail && 'cursor-default',
        )}
      >
        {!isPaused && (
          <IconComponent className="size-4 shrink-0 text-muted-foreground group-hover/tool-toggle:text-foreground" />
        )}

        <span className="truncate">
          {isError ? summary.replace(/^已/u, '') : summary}
          {isError ? ' · 失败' : ''}
        </span>

        {hasDetail && (
          <span
            aria-hidden="true"
            className={cn(
              'inline-flex size-3.5 shrink-0 text-muted-foreground/70 opacity-0 transition-[opacity,transform] duration-200 ease-out ml-0.5 group-hover/tool-toggle:opacity-100 group-focus-visible/tool-toggle:opacity-100',
              open ? 'rotate-0' : '-rotate-90',
            )}
          >
            <ChevronDown className="size-3.5" />
          </span>
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
          <div className="min-h-0 max-h-[min(20rem,50vh)] overflow-auto overscroll-contain">
            <div className="relative my-1 max-w-full rounded border border-border/40 bg-secondary/20 p-2 font-mono text-xs leading-relaxed text-muted-foreground select-text">
              <div className="flex items-center justify-between mb-1 pb-1 border-b border-border/30 font-sans text-muted-foreground/80">
                <span>{diff ? '变更内容 (Diff)' : isError ? '错误详情' : '输出内容'}</span>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1 px-1 py-0.5 rounded hover:text-foreground cursor-pointer"
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
                <NestedToolActivity key={child.id} tool={child} isLive={isLive} isPaused={isPaused} parentOpen={open} />
              ))}
              {!isError && <PluginToolCard tool={item} {...item.source} />}
            </div>
            {imagePreviews}
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
  parentOpen,
}: {
  tool: import('../model/types').ToolRun
  isLive: boolean
  isPaused: boolean
  parentOpen: boolean
}) {
  const [open, setOpen] = React.useState(false)
  if (!parentOpen && open) setOpen(false)
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
