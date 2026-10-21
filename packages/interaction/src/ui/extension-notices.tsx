import { X } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'
import { classifySystemError, SystemErrorCard } from '@pi-meme/ui/components/system-error-card'
import type { ExtensionNotice } from './use-extension-ui'

export function ExtensionNotices({
  notices,
  onDismiss,
  onOpenSettings,
  contained = false,
}: {
  notices: ExtensionNotice[]
  onDismiss: (id: number) => void
  onOpenSettings?: () => void
  contained?: boolean
}) {
  const errors = notices
    .filter((notice) => notice.type === 'error')
    .slice(-2)
    .reverse()
  const floating = notices.filter((notice) => notice.type !== 'error')
  if (!errors.length && !floating.length) return null
  const content = (
    <>
      {errors.map((notice) => {
        const copy = classifySystemError(notice.message)
        if (!copy.text) return null
        return (
          <div key={notice.id} aria-label="扩展通知" className="w-full">
            <SystemErrorCard
              title={copy.title}
              body={copy.body}
              detail={copy.text}
              live={copy.live}
              onOpenSettings={copy.settings && onOpenSettings ? onOpenSettings : undefined}
              onDismiss={() => onDismiss(notice.id)}
              className="pointer-events-auto w-full min-w-[240px] max-w-md animate-in slide-in-from-right-4 shadow-lg backdrop-blur-xs"
            />
          </div>
        )
      })}
      {floating.map((notice) => (
        <div
          aria-label="扩展通知"
          key={notice.id}
          className={cn(
            'pointer-events-auto flex w-full min-w-[240px] max-w-md items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs shadow-lg backdrop-blur-xs animate-in slide-in-from-right-4',
            notice.type === 'warning'
              ? 'border-amber-500/50 bg-amber-500/10 text-amber-500'
              : 'border-border bg-card text-foreground',
          )}
        >
          <span className="font-medium leading-relaxed">{notice.message}</span>
          <button
            type="button"
            aria-label="关闭通知"
            onClick={() => onDismiss(notice.id)}
            className="text-muted-foreground hover:text-foreground cursor-pointer shrink-0"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </>
  )
  if (contained) return content
  return (
    <div
      className="pointer-events-none fixed top-16 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col items-end gap-2"
      aria-live="polite"
    >
      {content}
    </div>
  )
}
