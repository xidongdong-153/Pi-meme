import { CircleAlert, X } from 'lucide-react'
import { cn } from '../lib/utils'

const extensionPattern = /Failed to load extension|无法加载 Pi 扩展/
const settingsPattern = /Pi.*路径|CLI|Node\.js|models\.json|API Key|API key|apiKey|模型配置|服务商配置/
const connectionPattern = /Host|连接被拒绝|未连接|Connection refused|ECONNREFUSED/

export function cleanSystemError(message: string) {
  return message
    .trim()
    .replace(/^(?:Error:\s*)*Error invoking remote method '[^']+':\s*/, '')
    .replace(/\bError:\s*/g, '')
    .trim()
}

export function classifySystemError(message: string, extension = false) {
  const text = cleanSystemError(message)
  const body = text.split(/\r?\n/)[0]?.replace(/\s+/g, ' ').trim() ?? ''
  const extensionFailure = extension || extensionPattern.test(text)
  const needsConfig = settingsPattern.test(text)
  const connection = connectionPattern.test(text)
  const title = extensionFailure
    ? '扩展没有加载'
    : needsConfig
      ? '需要检查配置'
      : connection
        ? '没有连上 Host'
        : '这次操作没有完成'
  return {
    text,
    body,
    title,
    settings: extensionFailure || needsConfig || connection,
    live: title === '没有连上 Host' ? ('polite' as const) : ('assertive' as const),
  }
}

export function SystemErrorCard({
  title,
  body,
  detail,
  live,
  onOpenSettings,
  onDismiss,
  className,
}: {
  title: string
  body: string
  detail: string
  live: 'polite' | 'assertive'
  onOpenSettings?: () => void
  onDismiss?: () => void
  className?: string
}) {
  if (!detail.trim()) return null
  const expandable = detail.trim() !== body.trim()
  return (
    <div
      data-system-error=""
      role={live === 'assertive' ? 'alert' : 'status'}
      className={cn('rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-xs', className)}
    >
      <div className="flex min-w-0 items-start gap-2">
        <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">{title}</p>
          {body && <p className="mt-0.5 break-words text-muted-foreground">{body}</p>}
          {expandable && (
            <details className="mt-1">
              <summary className="w-fit cursor-pointer list-none text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                详情
              </summary>
              <pre className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-mono leading-relaxed text-muted-foreground select-text">
                {detail}
              </pre>
            </details>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="cursor-pointer text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              打开设置
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              aria-label="关闭错误提示"
              onClick={onDismiss}
              className="cursor-pointer rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
