import { useState } from 'react'
import type { BrowserAnnotation } from '@pi-meme/contracts/browser'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Textarea } from '@pi-meme/ui/components/ui/textarea'
import { Globe, Pencil, Trash2 } from 'lucide-react'

export function AnnotationCard({
  annotation,
  onRemove,
  onChange,
}: {
  annotation: BrowserAnnotation
  onRemove?: () => void
  onChange?: (comment: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [comment, setComment] = useState(annotation.comment)
  return (
    <div className="w-72 max-w-full shrink-0 space-y-2 rounded-xl border border-border bg-card p-3 text-foreground">
      <div className="flex items-center gap-2">
        <Globe className="size-3.5 shrink-0" />
        <a
          href={annotation.url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          title={annotation.url}
        >
          {annotation.title || annotation.url}
        </a>
        {onChange ? (
          <Button
            size="icon-sm"
            variant="ghost"
            title="编辑批注"
            onClick={() => {
              setComment(annotation.comment)
              setEditing(!editing)
            }}
          >
            <Pencil className="size-3" />
          </Button>
        ) : null}
        {onRemove ? (
          <Button size="icon-sm" variant="ghost" title="删除批注" onClick={onRemove}>
            <Trash2 className="size-3" />
          </Button>
        ) : null}
      </div>
      {annotation.image ? (
        <img
          alt="网页批注截图"
          src={`data:${annotation.image.mimeType};base64,${annotation.image.data}`}
          className="max-h-32 w-full rounded border border-border object-contain"
        />
      ) : null}
      <p className="truncate text-xs text-muted-foreground">
        {annotation.tag || '区域'} · {annotation.name || annotation.text.slice(0, 100) || '截图批注'}
      </p>
      {editing ? (
        <>
          <Textarea
            aria-label="批注评论"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            maxLength={16000}
          />
          <Button
            size="sm"
            onClick={() => {
              onChange?.(comment)
              setEditing(false)
            }}
          >
            保存评论
          </Button>
        </>
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm">{annotation.comment || '分析选中的元素'}</p>
      )}
      <p className="text-[10px] text-muted-foreground">采集于 {new Date(annotation.capturedAt).toLocaleString()}</p>
    </div>
  )
}
