import type { ComponentProps, ReactNode } from 'react'
import type { DesktopSettings } from '@pi-meme/contracts/settings'
import { SettingsCard, SettingsGroup, SettingsRow } from '@pi-meme/ui/components/settings'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import { cn } from '@pi-meme/ui/lib/utils'
import { StorageSettings } from './storage-settings'

export function GeneralSettings({
  accessSettings,
  settings,
  onEditor,
  ...storage
}: {
  accessSettings: ReactNode
  settings?: DesktopSettings
  onEditor: (value: Pick<DesktopSettings, 'showComposerHint' | 'showContextUsage' | 'contextWindowArchive'>) => void
} & ComponentProps<typeof StorageSettings>) {
  return (
    <div className="space-y-6">
      <SettingsGroup title="编辑器">
        <SettingsCard>
          <SettingsRow className="flex-nowrap">
            <div className="min-w-0">
              <p className="font-medium">显示预测消息</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                根据对话显示下一步输入提示，按 Tab 填入输入框。
              </p>
            </div>
            <div
              className={cn(
                'h-6 w-11 shrink-0 transition-opacity duration-150 motion-reduce:transition-none',
                !settings && 'opacity-0',
              )}
              aria-busy={!settings}
              aria-label={!settings ? '正在读取预测消息设置' : undefined}
            >
              {settings && (
                <Switch
                  label="显示预测消息"
                  checked={settings.showComposerHint !== false}
                  onChange={(showComposerHint) => onEditor({ showComposerHint })}
                />
              )}
            </div>
          </SettingsRow>
          <SettingsRow className="flex-nowrap">
            <div className="min-w-0">
              <p className="font-medium">显示上下文窗口使用情况</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                在输入框中显示当前会话的上下文用量。
              </p>
            </div>
            <div
              className={cn(
                'h-6 w-11 shrink-0 transition-opacity duration-150 motion-reduce:transition-none',
                !settings && 'opacity-0',
              )}
              aria-busy={!settings}
              aria-label={!settings ? '正在读取上下文显示设置' : undefined}
            >
              {settings && (
                <Switch
                  label="显示上下文窗口使用情况"
                  checked={settings.showContextUsage !== false}
                  onChange={(showContextUsage) => onEditor({ showContextUsage })}
                />
              )}
            </div>
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup title="会话">
        <SettingsCard>
          <SettingsRow className="flex-nowrap">
            <div className="min-w-0">
              <p className="font-medium">归档上下文正文</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                默认关闭。开启后在本机保存完整提示词和回复，最多 1 GiB、30 日；临时会话不归档。
              </p>
            </div>
            <div
              className={cn(
                'h-6 w-11 shrink-0 transition-opacity duration-150 motion-reduce:transition-none',
                !settings && 'opacity-0',
              )}
              aria-busy={!settings}
              aria-label={!settings ? '正在读取上下文归档设置' : undefined}
            >
              {settings && (
                <Switch
                  label="归档上下文正文"
                  checked={settings.contextWindowArchive === true}
                  onChange={(contextWindowArchive) => onEditor({ contextWindowArchive })}
                />
              )}
            </div>
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup title="权限">
        <SettingsCard>{accessSettings}</SettingsCard>
      </SettingsGroup>
      <StorageSettings {...storage} />
    </div>
  )
}
