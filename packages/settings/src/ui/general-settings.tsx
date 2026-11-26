import type { ComponentProps, ReactNode } from 'react'
import type { DesktopSettings, GeneralSessionSettings } from '@pi-meme/contracts/settings'
import { SettingsCard, SettingsGroup, SettingsRow } from '@pi-meme/ui/components/settings'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import { cn } from '@pi-meme/ui/lib/utils'
import { StorageSettings } from './storage-settings'

export function GeneralSettings({
  mobile = false,
  accessSettings,
  settings,
  onEditor,
  ...storage
}: {
  mobile?: boolean
  accessSettings: ReactNode
  settings?: DesktopSettings
  onEditor: (value: GeneralSessionSettings) => void
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
              <p className="font-medium">任务进度</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                允许模型在多步任务中更新对话内的清单。更改从下一轮生效，已有清单可以回看。
              </p>
            </div>
            <div className="h-6 w-11 shrink-0" aria-busy={!settings}>
              {settings && (
                <Switch
                  label="任务进度"
                  checked={settings.taskProgressEnabled !== false}
                  onChange={(taskProgressEnabled) => onEditor({ taskProgressEnabled })}
                />
              )}
            </div>
          </SettingsRow>
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
      <StorageSettings mobile={mobile} {...storage} />
    </div>
  )
}
