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
    <div className="flex items-center justify-between gap-6 py-4">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">新会话默认权限</p>
        <p role="status" className="text-sm leading-relaxed text-muted-foreground">
          {selected.description} 仅影响新建会话，已保存的会话保留各自权限。
        </p>
        {!supported && (
          <p className="text-sm text-muted-foreground">
            {reason ?? '当前设备无法使用受限权限，请检查系统配置后重启应用。'}
          </p>
        )}
      </div>
      <Select
        value={mode}
        disabled={busy || saving}
        onValueChange={(next) => {
          if (isAgentAccessMode(next)) onSave(next)
        }}
      >
        <SelectTrigger
          aria-label="新会话默认权限"
          className="h-8 w-auto max-w-full shrink-0 rounded-full border-0 bg-secondary px-3 shadow-none"
        >
          <span className="truncate">{selected.label}</span>
        </SelectTrigger>
        <SelectContent align="end">
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
  )
}
