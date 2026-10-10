import { X } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'
import type { ExtensionNotice } from './use-extension-ui'

export function ExtensionNotices({
  notices,
  onDismiss,
}: {
  notices: ExtensionNotice[]
  onDismiss: (id: number) => void
}) {
  return (
    <>
      {notices.length > 0 && (
        <div className="fixed top-16 right-4 z-50 flex flex-col gap-2 pointer-events-none" aria-live="polite">
          {notices.map((notice) => (
            <div
              aria-label="扩展通知"
              key={notice.id}
              className={cn(
                'pointer-events-auto flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs shadow-lg backdrop-blur-xs min-w-[240px] max-w-md animate-in slide-in-from-right-4',
                notice.type === 'error'
                  ? 'border-destructive/50 bg-destructive/10 text-destructive'
                  : notice.type === 'warning'
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
        </div>
      )}
    </>
  )
}
