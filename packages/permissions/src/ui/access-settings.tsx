import { useState } from 'react'
import {
  agentAccessChoices,
  defaultAccessMode,
  isAgentAccessMode,
  type AgentAccessMode,
} from '@pi-meme/contracts/agent-access'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@pi-meme/ui/components/ui/select'
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { SettingsRow, settingsControlClassName } from '@pi-meme/ui/components/settings'
import { cn } from '@pi-meme/ui/lib/utils'

import { FullAccessConfirmation } from './full-access-confirmation'

const descriptions = agentAccessChoices.map((choice) => choice.description)
const labels = agentAccessChoices.map((choice) => choice.label)

export function AccessSettings({
  value,
  loading = false,
  supported,
  reason,
  busy,
  saving,
  onSave,
}: {
  value?: AgentAccessMode
  loading?: boolean
  supported: boolean
  reason?: string
  busy: boolean
  saving: boolean
  onSave: (mode: AgentAccessMode) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const mode = value ?? defaultAccessMode
  const selected = agentAccessChoices.find((choice) => choice.mode === mode)!
  return (
    <>
      <SettingsRow>
        <div className="min-w-0 flex-1 basis-56">
          <p className="font-medium">新会话默认权限</p>
          <p role="status" className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            <CrossfadeText reserve={descriptions} className="grid">
              {loading ? '正在读取权限…' : selected.description}
            </CrossfadeText>
            <span className="block">仅影响新建会话，已保存的会话保留各自权限。</span>
          </p>
          {!supported && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {reason ?? '当前设备无法使用受限权限，请检查系统配置后重启应用。'}
            </p>
          )}
        </div>
        <Select
          value={mode}
          disabled={loading || busy || saving}
          onValueChange={(next) => {
            if (!isAgentAccessMode(next) || next === mode) return
            if (next === 'full-access') setConfirming(true)
            else onSave(next)
          }}
        >
          <SelectTrigger
            aria-label="新会话默认权限"
            className={cn(settingsControlClassName, 'w-auto shrink-0 bg-secondary/60 px-3')}
          >
            <CrossfadeText reserve={labels} textClassName="truncate">
              {loading ? '读取中…' : selected.label}
            </CrossfadeText>
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
      </SettingsRow>
      <FullAccessConfirmation
        open={confirming && !loading && !busy && !saving && mode !== 'full-access'}
        onOpenChange={setConfirming}
        onConfirm={() => {
          if (!loading && !busy && !saving) onSave('full-access')
        }}
      />
    </>
  )
}
