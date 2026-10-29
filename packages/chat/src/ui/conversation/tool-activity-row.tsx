import * as React from 'react'
import { PluginToolCard } from '@pi-meme/ui/components/plugin-tool-card'
import { PluginMessageActions } from '@pi-meme/ui/components/plugin-message-actions'
import { Button } from '@pi-meme/ui/components/ui/button'
import type { ActivityItem } from '../model/types'
import { cn } from '@pi-meme/ui/lib/utils'
import { BookOpen, ChevronDown, Images, Pencil, Search, Sparkles, SquareTerminal, Wrench } from 'lucide-react'
import {
  extractDiff,
  extractFilePatch,
  extractImages,
  fileChangeStats,
  formatDetailValue,
  parseToolMeta,
} from '../model/tool-details'
import { FileToolDiff } from './file-tool-diff'
import { runningActivityLabel } from '../model/activity-summary'
import { ToolDiff } from './tool-diff'
import { ImageThumbnail } from '../content/message-image'
import { imageSource } from '../content/image-viewer'
import { toolMessageActionAnchor } from '../model/tool-message-action-anchor'

export function ToolActivityRow({
  item,
  open,
  onToggle,
  isLive = true,
  isPaused = false,
  className,
  actions,
}: {
  item: Extract<ActivityItem, { type?: 'tool' }>
  open: boolean
  onToggle: () => void
  isLive?: boolean
  isPaused?: boolean
  className?: string
  actions?: React.ReactNode
}) {
  const [copied, setCopied] = React.useState(false)
  const isRunning = isLive && item.status === 'running'
  const isError = item.status === 'error'

  const meta = parseToolMeta(item)
  const fileChange =
    !isRunning && !isError && (meta.kind === 'edit' || meta.kind === 'write') ? fileChangeStats(item.result) : undefined
  const summary = isRunning && !isPaused ? runningActivityLabel([item]).replace(/…$/, '') : meta.summary
  const IconComponent = {
    command: SquareTerminal,
    read: BookOpen,
    write: Pencil,
    edit: Pencil,
    image: Images,
    'image-generation': Images,
    search: Search,
    generic: Wrench,
    thinking: Sparkles,
  }[meta.kind]

  const isFileMutation = meta.kind === 'edit' || meta.kind === 'write'
  const filePatch = isFileMutation && !isError && !isRunning ? extractFilePatch(item.result) : null
  const [hasOpened, setHasOpened] = React.useState(open)
  if (open && !hasOpened) setHasOpened(true)
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
  const actionAnchor = toolMessageActionAnchor(item, rawText)
  const hasDetail = isFileMutation
    ? Boolean(filePatch)
    : meta.kind !== 'read' &&
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
    <div className="flex flex-wrap">
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
    return (
      <div className={cn('flex items-start gap-1', className)}>
        {imagePreviews}
        {actions === undefined ? actionAnchor && <PluginMessageActions {...actionAnchor} /> : actions}
      </div>
    )

  return (
    <div className={cn('text-xs select-none', className)}>
      <div className="flex min-w-0 items-center gap-1">
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
            'text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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

          {fileChange && (
            <span className="inline-flex shrink-0 gap-1 font-mono tabular-nums">
              <span className="group-hover/tool-toggle:text-emerald-600 group-focus-visible/tool-toggle:text-emerald-600 dark:group-hover/tool-toggle:text-emerald-400 dark:group-focus-visible/tool-toggle:text-emerald-400">
                +{fileChange.insertions}
              </span>
              <span className="group-hover/tool-toggle:text-rose-600 group-focus-visible/tool-toggle:text-rose-600 dark:group-hover/tool-toggle:text-rose-400 dark:group-focus-visible/tool-toggle:text-rose-400">
                −{fileChange.deletions}
              </span>
            </span>
          )}
          {fileChange?.created && (
            <span
              className="size-1.5 shrink-0 rounded-full bg-blue-500"
              role="img"
              aria-label="新建文件"
              title="新建文件"
            />
          )}

          {hasDetail && (
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex size-3.5 shrink-0 text-muted-foreground/70 opacity-0 transition-[opacity,rotate] duration-200 ease-out motion-reduce:transition-none ml-0.5 group-hover/tool-toggle:opacity-100 group-focus-visible/tool-toggle:opacity-100',
                open ? 'rotate-0 opacity-100' : '-rotate-90',
              )}
            >
              <ChevronDown className="size-3.5" />
            </span>
          )}
        </div>
        {actions === undefined ? actionAnchor && <PluginMessageActions {...actionAnchor} /> : actions}
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
            {filePatch ? (
              hasOpened && <FileToolDiff patch={filePatch} path={meta.fullPath} />
            ) : (
              <div className="relative my-2 max-w-full pr-2 pb-2 pt-10 font-mono text-xs leading-relaxed text-muted-foreground select-text">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={handleCopy}
                  className="absolute right-0 top-2 h-7 border-0 bg-transparent px-1 font-sans text-xs font-normal text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground"
                  title="复制输出"
                  aria-label={copied ? '已复制' : '复制输出'}
                >
                  {copied ? '已复制' : '复制'}
                </Button>

                <div className="max-h-[min(20rem,50vh)] overflow-auto overscroll-contain">
                  {script && (
                    <>
                      <p className="mb-1">执行脚本</p>
                      <pre aria-label="codemode 执行脚本" className="mb-3 whitespace-pre-wrap">
                        {script}
                      </pre>
                    </>
                  )}
                  {diff ? (
                    <ToolDiff diff={diff} />
                  ) : rawText ? (
                    <pre className="whitespace-pre-wrap">{rawText}</pre>
                  ) : null}

                  {item.children?.map((child) => (
                    <NestedToolActivity
                      key={child.id}
                      tool={child}
                      isLive={isLive}
                      isPaused={isPaused}
                      parentOpen={open}
                    />
                  ))}
                  {!isError && <PluginToolCard tool={item} {...item.source} />}
                </div>
              </div>
            )}
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
    <div className="mt-1" data-parent-tool={tool.parentToolCallId}>
      <ToolActivityRow item={tool} open={open} onToggle={() => setOpen(!open)} isLive={isLive} isPaused={isPaused} />
    </div>
  )
}
