import { GitFork, Loader2, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'

/** Fork 的进行中与成功反馈，位于工作区右上角。系统错误 Toast 也在视口右上角，同时出现时错误在上层。 */
export function ForkNotice({
  forking,
  sourcePath,
  sourceTitle,
  onOpenSource,
  onDismiss,
}: {
  forking: boolean
  sourcePath?: string
  sourceTitle?: string
  onOpenSource: (sourcePath: string) => void
  onDismiss: () => void
}) {
  if (forking)
    return (
      <div
        role="status"
        data-testid="fork-pending"
        className="absolute top-14 right-4 z-40 flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 text-xs shadow-xl animate-in fade-in slide-in-from-top-2"
      >
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin text-primary" />
        <span className="text-foreground">正在创建分支…</span>
      </div>
    )
  if (!sourcePath) return null
  return (
    <div
      role="status"
      data-testid="fork-success"
      className="absolute top-14 right-4 z-40 flex items-center gap-2 rounded-xl border border-primary/40 bg-card px-3.5 py-2.5 text-xs shadow-xl animate-in fade-in slide-in-from-top-2"
    >
      <GitFork aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
      <span className="text-foreground">已创建分支</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`返回来源会话：${sourceTitle || '来源会话'}`}
            onClick={() => onOpenSource(sourcePath)}
            className="shrink-0 rounded px-2 py-0.5 text-primary transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            返回
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{`返回来源：${sourceTitle || '来源会话'}`}</TooltipContent>
      </Tooltip>
      <button
        type="button"
        aria-label="关闭提示"
        onClick={onDismiss}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
