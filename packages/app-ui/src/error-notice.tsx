import { AlertCircle, X } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'

export function ErrorNotice({
  message,
  onOpenSettings,
  onDismiss,
  extension = false,
}: {
  message: string
  onOpenSettings: () => void
  onDismiss: () => void
  extension?: boolean
}) {
  if (!message) return null
  const text = message
    .trim()
    .replace(/^(?:Error:\s*)*Error invoking remote method '[^']+':\s*/, '')
    .replace(/\bError:\s*/g, '')
    .trim()
  const extensionFailure = extension || /Failed to load extension|无法加载 Pi 扩展/.test(text)
  const needsSettings =
    extensionFailure || /Pi.*路径|CLI|Node\.js|models\.json|API Key|API key|apiKey|模型配置|服务商配置/.test(text)
  return (
    <div
      role="alert"
      className="shrink-0 mx-4 my-2 rounded-xl border border-destructive/50 bg-card p-3 text-xs flex items-start gap-2.5 text-destructive"
    >
      <AlertCircle aria-hidden="true" className="size-4 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="max-h-20 overflow-y-auto break-words font-medium whitespace-pre-wrap leading-relaxed">{text}</p>
        {extensionFailure && <p>在设置的 Pi 扩展中移除该路径后重新保存，或修正对应扩展。</p>}
        {needsSettings ? (
          <Button
            variant="outline"
            size="xs"
            onClick={onOpenSettings}
            className="h-6 text-xs border-destructive/40 text-destructive hover:bg-destructive/10"
          >
            打开设置
          </Button>
        ) : (
          <p>发送失败时，可检查输入内容后再次点击发送。</p>
        )}
      </div>
      <button
        type="button"
        aria-label="关闭错误提示"
        onClick={onDismiss}
        className="shrink-0 rounded text-destructive/70 hover:text-destructive cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
