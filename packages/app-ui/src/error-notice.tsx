import { ErrorLine } from '@pi-meme/ui/components/error-line'

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
    <ErrorLine
      message={text}
      onDismiss={onDismiss}
      className="shrink-0 mx-4 my-2 text-xs"
      actions={
        needsSettings ? (
          <button
            type="button"
            onClick={onOpenSettings}
            className="cursor-pointer text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            打开设置
          </button>
        ) : undefined
      }
    />
  )
}
