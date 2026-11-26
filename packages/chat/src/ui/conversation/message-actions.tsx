import { Check, Copy, Ellipsis, GitFork, Pencil } from 'lucide-react'
import { useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'

export function MessageActions({
  mobile = false,
  onCopy,
  onEdit,
  onFork,
  onCopyError,
  canCopy = true,
  canEdit = true,
  canFork = true,
  side = 'top',
}: {
  mobile?: boolean
  onCopy: () => Promise<void>
  onEdit?: () => void
  onFork?: () => void
  onCopyError?: (message: string) => void
  canCopy?: boolean
  canEdit?: boolean
  canFork?: boolean
  side?: 'top' | 'bottom'
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    if (!canCopy) return
    try {
      await onCopy()
      setCopied(true)
      setTimeout(setCopied, 2000, false)
    } catch {
      onCopyError?.('复制失败，请重试')
    }
  }

  if (mobile) {
    const hasMore = Boolean(onFork || onEdit)
    return (
      <div className="flex items-center gap-0.5 text-muted-foreground/80">
        <button
          type="button"
          disabled={!canCopy}
          onClick={() => void copy()}
          aria-label={copied ? '已复制' : '复制消息'}
          className="inline-flex size-9 items-center justify-center rounded-xl transition-colors active:bg-secondary active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
        >
          {copied ? <Check className="size-4 text-primary" /> : <Copy className="size-4" />}
        </button>
        {hasMore && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="更多消息操作"
                className="inline-flex size-9 items-center justify-center rounded-xl transition-colors active:bg-secondary active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Ellipsis className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-44 rounded-xl p-1">
              {onEdit && (
                <DropdownMenuItem
                  disabled={!canEdit}
                  onSelect={onEdit}
                  className="min-h-[40px] gap-2.5 rounded-lg text-sm"
                >
                  <Pencil className="size-4" />
                  <span>编辑消息</span>
                </DropdownMenuItem>
              )}
              {onFork && (
                <DropdownMenuItem
                  disabled={!canFork}
                  onSelect={onFork}
                  className="min-h-[40px] gap-2.5 rounded-lg text-sm"
                >
                  <GitFork className="size-4" />
                  <span>从此处分叉</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1 text-muted-foreground/70">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={!canCopy}
            onClick={() => void copy()}
            aria-label={copied ? '已复制' : '复制消息'}
            className={cn(
              'inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-secondary/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side={side}>{copied ? '已复制' : '复制'}</TooltipContent>
      </Tooltip>
      {onEdit && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={!canEdit}
              onClick={onEdit}
              aria-label="编辑消息"
              className="inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-secondary/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Pencil className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side={side}>{canEdit ? '编辑' : '会话运行时不能编辑'}</TooltipContent>
        </Tooltip>
      )}
      {onFork && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={!canFork}
              onClick={onFork}
              aria-label="从这段回复新建会话"
              className="inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-secondary/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
            >
              <GitFork className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side={side}>{canFork ? '分叉' : '会话运行时不能新建'}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
