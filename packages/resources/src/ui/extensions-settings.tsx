import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import { Button } from '@pi-meme/ui/components/ui/button'

export function ExtensionsSettings({
  mode,
  busy,
  onOpen,
}: {
  mode?: AgentAccessMode
  busy: boolean
  onOpen: () => void
}) {
  return (
    <div className="space-y-4">
      <p>Pi 扩展保存在当前连接的设备上，只在完全访问模式运行。</p>
      <p className="text-sm text-muted-foreground">
        {mode === 'full-access' ? '当前聊天可以运行已启用的 Pi 扩展。' : '当前权限设置不允许运行 Pi 扩展。'}
      </p>
      <Button variant="outline" disabled={busy} onClick={onOpen}>
        打开扩展目录
      </Button>
    </div>
  )
}
