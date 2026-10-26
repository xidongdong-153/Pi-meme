import { useState } from 'react'
import type { BrowserAnnotation } from '@pi-meme/contracts/browser'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { MessageSquare, Pencil, Trash2, X } from 'lucide-react'

export function ComposerAnnotationSummary({
  annotations,
  disabled,
  onRemove,
  onChange,
}: {
  annotations: Array<{ id: string; value: BrowserAnnotation }>
  disabled?: boolean
  onRemove: (id: string) => void
  onChange?: (id: string, comment: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  return (
    <Popover open={open && annotations.length > 0} onOpenChange={setOpen}>
      {annotations.length > 0 ? (
        <div className="group mb-2 inline-flex h-8 w-fit max-w-full self-start items-center rounded-xl border border-border bg-secondary/50 text-xs">
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex h-full min-w-0 items-center gap-1.5 px-2.5"
              aria-label={`查看 ${annotations.length} 条批注`}
            >
              <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="whitespace-nowrap">{annotations.length} 条注释</span>
            </button>
          </PopoverTrigger>
          <Button
            size="icon-sm"
            variant="ghost"
            className="mr-1 size-6 rounded-full opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            aria-label="移除全部浏览器批注"
            disabled={disabled}
            onClick={() => {
              setOpen(false)
              for (const item of annotations) onRemove(item.id)
            }}
          >
            <X className="size-3" />
          </Button>
        </div>
      ) : null}
      <PopoverContent
        side="top"
        align="start"
        className="max-h-80 w-[min(350px,calc(100vw-32px))] overflow-y-auto p-1.5"
      >
        <div className="divide-y divide-border/70">
          {annotations.map(({ id, value }, index) => (
            <div key={id} className="px-2.5 py-3">
              <div className="flex items-center gap-2">
                {value.image ? (
                  <img
                    src={`data:${value.image.mimeType};base64,${value.image.data}`}
                    alt="批注截图"
                    className="size-7 shrink-0 rounded-md object-cover"
                  />
                ) : (
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-background">
                    <MessageSquare className="size-3.5" />
                  </div>
                )}
                <span className="rounded-md border border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                  {value.tag || '区域'}
                </span>
                <span className="min-w-0 flex-1" />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="size-6"
                  aria-label={`编辑第 ${index + 1} 条批注`}
                  disabled={disabled || !onChange}
                  onClick={() => {
                    setEditing(id)
                    setComment(value.comment)
                  }}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="size-6"
                  aria-label="删除批注"
                  disabled={disabled}
                  onClick={() => {
                    if (annotations.length === 1) setOpen(false)
                    onRemove(id)
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              {editing === id ? (
                <div className="mt-2 space-y-2">
                  <textarea
                    aria-label="编辑批注评论"
                    className="min-h-14 w-full resize-none rounded-md border border-border bg-background p-2 text-xs outline-none"
                    value={comment}
                    maxLength={16000}
                    onChange={(event) => setComment(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        onChange?.(id, comment)
                        setEditing(null)
                      }
                    }}
                  />
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      取消
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        onChange?.(id, comment)
                        setEditing(null)
                      }}
                    >
                      保存
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="mt-2 whitespace-pre-wrap break-words text-xs">{value.comment || '分析选中的元素'}</p>
              )}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
