import { Check, Copy, GitFork, Pencil } from 'lucide-react'
import { useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'

export function MessageActions({
  onCopy,
  onEdit,
  onFork,
  onCopyError,
  canCopy = true,
  canEdit = true,
  canFork = true,
  side = 'top',
}: {
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

  return (
    <div className="flex items-center gap-1 text-muted-foreground/70">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={!canCopy}
            onClick={() => void copy()}
            aria-label={copied ? '已复制' : '复制消息'}
            className="inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-secondary/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
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
