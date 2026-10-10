import { useState } from 'react'
import type { ToolExecutionSettings } from '@pi-meme/contracts/settings'
import { Button } from '@pi-meme/ui/components/ui/button'

export function ToolExecutionSettingsPanel({
  value,
  busy,
  saving,
  onSave,
}: {
  value: ToolExecutionSettings
  busy: boolean
  saving: boolean
  onSave: (value: ToolExecutionSettings) => void
}) {
  const [enabled, setEnabled] = useState(value.codemodeEnabled)
  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          aria-label="启用 codemode"
          checked={enabled}
          disabled={busy || saving}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        启用 codemode
      </label>
      <p className="text-sm text-muted-foreground">
        允许 Agent 用 JavaScript 并行调用、筛选和组合已有工具。脚本内调用继续遵循当前会话的文件访问权限。
      </p>
      {!enabled && value.mcpEnabled && (
        <p role="status" className="text-sm">
          保存后将同时关闭 Desktop MCP，Desktop 全局服务配置会保留。
        </p>
      )}
      <Button
        disabled={busy || saving}
        onClick={() => onSave({ codemodeEnabled: enabled, mcpEnabled: enabled && value.mcpEnabled })}
      >
        {saving ? '正在保存…' : '保存工具执行设置'}
      </Button>
    </div>
  )
}
