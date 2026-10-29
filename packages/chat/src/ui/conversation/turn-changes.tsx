import { useEffect, useRef, useState } from 'react'
import { ChevronDown, FileDiff, Undo2 } from 'lucide-react'
import type { TurnChanges } from '@pi-meme/contracts/turn-changes'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'

export function ChangeCounts({ insertions, deletions }: Pick<TurnChanges, 'insertions' | 'deletions'>) {
  return (
    <span className="inline-flex shrink-0 gap-1.5 font-mono tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{insertions}</span>
      <span className="text-rose-600 dark:text-rose-400">−{deletions}</span>
    </span>
  )
}

function ChangeFiles({
  changes,
  expanded = true,
  onView,
}: {
  changes: TurnChanges
  expanded?: boolean
  onView: (entryId: string, path?: string) => void
}) {
  return (
    <ul className="min-w-0 py-1">
      {(expanded ? changes.files : changes.files.slice(0, 3)).map((file) => (
        <li key={file.path}>
          <button
            type="button"
            onClick={() => onView(changes.entryId, file.path)}
            className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left text-xs hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={file.path}>
              {file.path}
            </span>
            <ChangeCounts {...file} />
          </button>
        </li>
      ))}
    </ul>
  )
}

export function LiveTurnChanges({
  changes,
  onView,
}: {
  changes: TurnChanges
  onView: (entryId: string, path?: string) => void
}) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const enter = () => {
    clearTimeout(timer.current)
    setOpen(true)
  }
  const leave = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(setOpen, 180, false)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  if (!changes.files.length || changes.undone) return null
  return (
    <div className="flex justify-center pb-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            onPointerEnter={enter}
            onPointerLeave={leave}
            onFocus={enter}
            aria-label={`本轮 ${changes.files.length} 个文件已更改`}
            className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-secondary/80 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>{changes.files.length} 个文件已更改</span>
            <ChangeCounts {...changes} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="center"
          className="max-h-72 w-96 max-w-[calc(100vw-2rem)] overflow-y-auto p-1"
          onPointerEnter={enter}
          onPointerLeave={leave}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <ChangeFiles
            changes={changes}
            onView={(entryId, path) => {
              clearTimeout(timer.current)
              setOpen(false)
              onView(entryId, path)
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}

export function TurnChangesCard({
  changes,
  onView,
  onUndo,
  disabled,
}: {
  changes: TurnChanges
  onView: (entryId: string, path?: string) => void
  onUndo: (entryId: string) => Promise<void>
  disabled?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [error, setError] = useState('')
  if (!changes.files.length) return null
  const undo = async () => {
    if (undoing) return
    setUndoing(true)
    setError('')
    try {
      await onUndo(changes.entryId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setUndoing(false)
    }
  }
  return (
    <section
      aria-label="本轮代码变更"
      className="my-3 w-full overflow-hidden rounded-xl border border-border/70 bg-card/60 text-xs"
    >
      <div className="flex flex-wrap items-center gap-3 px-3 py-3">
        <FileDiff aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-32 flex-1">
          <p className="mb-1 font-medium">
            {changes.undone ? '已撤销' : '已编辑'} {changes.files.length} 个文件
          </p>
          <ChangeCounts {...changes} />
        </div>
        {!changes.undone && (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || undoing || Boolean(changes.undoUnavailable)}
            title={changes.undoUnavailable}
            onClick={() => void undo()}
          >
            <Undo2 className="size-3.5" />
            {undoing ? '正在撤销…' : '撤销'}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => onView(changes.entryId)}>
          查看变更
        </Button>
      </div>
      {error && (
        <p role="alert" className="px-3 pb-3 text-destructive">
          {error}
        </p>
      )}
      <div className="border-t border-border/60">
        <ChangeFiles changes={changes} expanded={expanded} onView={onView} />
      </div>
      {changes.files.length > 3 && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-1.5 border-t border-border/60 px-3 py-2 text-muted-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {expanded ? '收起文件列表' : `再显示 ${changes.files.length - 3} 个文件`}
          <ChevronDown className={`size-3.5 ${expanded ? 'rotate-180' : ''}`} />
        </button>
      )}
    </section>
  )
}
