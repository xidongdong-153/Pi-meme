import type { SubagentCatalogSnapshot } from '@pi-meme/contracts/settings'
import { Button } from '@pi-meme/ui/components/ui/button'
import { useState } from 'react'

export function SubagentsSettings({
  catalog,
  enabled: initialEnabled,
  enabledAgentIds: initialEnabledAgentIds,
  busy,
  saving,
  onSave,
  onReload,
}: {
  catalog: SubagentCatalogSnapshot | null
  enabled: boolean
  enabledAgentIds: string[]
  busy: boolean
  saving: boolean
  onSave: (enabled: boolean, enabledAgentIds: string[]) => void
  onReload: () => void
}) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [enabledAgentIds, setEnabledAgentIds] = useState(initialEnabledAgentIds)
  const disabled = busy || saving

  function toggleAgent(id: string, checked: boolean) {
    setEnabledAgentIds((previous) =>
      checked ? [...new Set([...previous, id])].sort() : previous.filter((entry) => entry !== id),
    )
  }

  return (
    <div className="space-y-5">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          aria-label="启用 SubAgent"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        启用 SubAgent
      </label>
      <p className="text-sm text-muted-foreground">
        Agent 定义保存在 <code>{catalog?.directory ?? 'Desktop 数据目录/pi/subagents'}</code>。每个 Markdown
        文件定义一个 Agent。
      </p>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Agent 定义</h3>
        <Button variant="outline" size="sm" disabled={disabled} onClick={onReload}>
          重新扫描
        </Button>
      </div>
      {catalog?.agents.length ? (
        <div className="divide-y divide-border rounded-lg border border-border">
          {catalog.agents.map((agent) => (
            <label key={agent.id} className="flex items-start gap-3 p-4">
              <input
                type="checkbox"
                aria-label={`启用 Agent ${agent.id}`}
                checked={enabledAgentIds.includes(agent.id)}
                disabled={disabled}
                onChange={(event) => toggleAgent(agent.id, event.target.checked)}
              />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="block text-sm font-medium">{agent.id}</span>
                <span className="block text-sm text-muted-foreground">{agent.description}</span>
                <span className="block text-xs text-muted-foreground">
                  工具：{agent.tools.join(', ') || '无'}；最多 {agent.maxTurns} 轮
                </span>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          未找到有效定义。请在上述目录添加 Markdown 文件，然后重新扫描。
        </p>
      )}
      {catalog?.diagnostics.length ? (
        <div className="space-y-2 rounded-lg border border-destructive/40 p-4" role="status">
          <h3 className="text-sm font-medium">定义诊断</h3>
          {catalog.diagnostics.map((diagnostic, index) => (
            <p key={`${diagnostic.path}:${index}`} className="break-all text-xs text-muted-foreground">
              {diagnostic.path}: {diagnostic.message}
            </p>
          ))}
        </div>
      ) : null}
      <div className="flex justify-end">
        <Button disabled={disabled} onClick={() => onSave(enabled, enabledAgentIds)}>
          {saving ? '正在保存…' : '保存 SubAgent 设置'}
        </Button>
      </div>
    </div>
  )
}
