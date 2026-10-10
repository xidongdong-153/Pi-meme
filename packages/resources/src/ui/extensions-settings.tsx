import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import { Button } from '@pi-meme/ui/components/ui/button'

export function ExtensionsSettings({
  directory,
  mode,
  busy,
  onOpen,
}: {
  directory: string
  mode?: AgentAccessMode
  busy: boolean
  onOpen: () => void
}) {
  return (
    <div className="space-y-4">
      <p>Desktop 从应用数据目录加载扩展。扩展只在完全访问模式运行。</p>
      <p className="break-all font-mono text-xs text-muted-foreground select-text">{directory}</p>
      <p className="text-sm text-muted-foreground">
        {mode === 'full-access' ? '当前会话允许加载应用目录中的扩展。' : '当前权限模式不会运行扩展。'}
      </p>
      <Button variant="outline" disabled={busy} onClick={onOpen}>
        打开扩展目录
      </Button>
    </div>
  )
}
