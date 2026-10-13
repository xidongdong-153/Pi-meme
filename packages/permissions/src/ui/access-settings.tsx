import {
  agentAccessChoices,
  defaultAccessMode,
  isAgentAccessMode,
  type AgentAccessMode,
} from '@pi-meme/contracts/agent-access'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@pi-meme/ui/components/ui/select'

export function AccessSettings({
  value,
  supported,
  reason,
  busy,
  saving,
  onSave,
}: {
  value?: AgentAccessMode
  supported: boolean
  reason?: string
  busy: boolean
  saving: boolean
  onSave: (mode: AgentAccessMode) => void
}) {
  const mode = value ?? defaultAccessMode
  const selected = agentAccessChoices.find((choice) => choice.mode === mode)!
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <p className="text-sm font-medium">新会话默认权限</p>
          <p className="text-sm text-muted-foreground">仅影响新建会话，已保存的会话保留各自权限。</p>
        </div>
        <Select
          value={mode}
          disabled={busy || saving}
          onValueChange={(next) => {
            if (isAgentAccessMode(next)) onSave(next)
          }}
        >
          <SelectTrigger aria-label="新会话默认权限" className="w-44 shrink-0">
            <span className="truncate">{selected.label}</span>
          </SelectTrigger>
          <SelectContent>
            {agentAccessChoices.map((choice) => (
              <SelectItem
                key={choice.mode}
                value={choice.mode}
                textValue={choice.label}
                disabled={!supported && choice.mode !== 'full-access'}
                className="py-2.5"
              >
                <span className="flex flex-col gap-1">
                  <span className="font-medium">{choice.label}</span>
                  <span className="text-xs text-muted-foreground">{choice.description}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {selected.description}
        {saving ? ' 正在保存…' : ''}
      </p>
      {!supported && (
        <p className="text-sm text-muted-foreground">
          {reason ?? '所属 Host 的受限权限沙箱不可用，请检查系统依赖后重启 Host。'}
        </p>
      )}
    </div>
  )
}
