import { X } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'
import type { ExtensionNotice } from './use-extension-ui'
import { ErrorLine } from '@pi-meme/ui/components/error-line'

export function ExtensionNotices({
  notices,
  onDismiss,
}: {
  notices: ExtensionNotice[]
  onDismiss: (id: number) => void
}) {
  const errors = notices.filter((notice) => notice.type === 'error')
  const floating = notices.filter((notice) => notice.type !== 'error')
  return (
    <>
      {errors.map((notice) => (
        <div key={notice.id} aria-label="扩展通知" className="shrink-0 mx-4 my-2">
          <ErrorLine message={notice.message} onDismiss={() => onDismiss(notice.id)} className="text-xs" />
        </div>
      ))}
      {floating.length > 0 && (
        <div className="fixed top-16 right-4 z-50 flex flex-col gap-2 pointer-events-none" aria-live="polite">
          {floating.map((notice) => (
            <div
              aria-label="扩展通知"
              key={notice.id}
              className={cn(
                'pointer-events-auto flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs shadow-lg backdrop-blur-xs min-w-[240px] max-w-md animate-in slide-in-from-right-4',
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
        </div>
      )}
    </>
  )
}
