import * as React from 'react'
import type { ReactNode } from 'react'
import { ChevronRight, X } from 'lucide-react'
import { cn } from '../lib/utils'

function errorPreview(message: string) {
  let text = message.replace(/^(?:Error:\s*)+/, '')
  const json = text.match(/^(?:\d{3}:?\s*)?(\{[\s\S]*\})$/)?.[1]
  if (json) {
    try {
      const payload = JSON.parse(json) as { message?: unknown; error?: { message?: unknown } }
      const reason = payload.message ?? payload.error?.message
      if (typeof reason === 'string' && reason.trim()) text = reason.trim()
    } catch {
      /* 保留无法解析的原始摘要。 */
    }
  }
  return text.split(/\r?\n/)[0].replace(/\s+/g, ' ').trim()
}

export function ErrorLine({
  message,
  summary,
  suffix,
  actions,
  onDismiss,
  className,
}: {
  message: string
  summary?: string
  suffix?: string
  actions?: ReactNode
  onDismiss?: () => void
  className?: string
}) {
  const detail = message.trim()
  if (!detail) return null
  const preview = summary ?? errorPreview(detail)

  return (
    <div data-error-line="" className={cn('min-w-0 text-sm leading-relaxed', className)}>
      <div className="flex min-w-0 items-start gap-2">
        <details className="group/error min-w-0 flex-1">
          <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <span role="status" className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="min-w-0 truncate text-destructive">{preview}</span>
              {suffix && <span className="shrink-0 whitespace-nowrap text-destructive">{suffix}</span>}
            </span>
            <ChevronRight
              aria-hidden="true"
              className="size-3 shrink-0 text-muted-foreground transition-transform group-open/error:rotate-90"
            />
          </summary>
          <pre className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-mono text-xs leading-relaxed text-muted-foreground select-text">
            {detail}
          </pre>
        </details>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        {onDismiss && (
          <button
            type="button"
            aria-label="关闭错误提示"
            onClick={onDismiss}
            className="shrink-0 cursor-pointer rounded-sm py-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
