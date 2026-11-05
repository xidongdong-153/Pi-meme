import type { ComponentProps, ReactNode } from 'react'
import type { DesktopSettings } from '@pi-meme/contracts/settings'
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
  onEditor: (value: Pick<DesktopSettings, 'showComposerHint' | 'showContextUsage'>) => void
} & ComponentProps<typeof StorageSettings>) {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-medium">编辑器</h3>
        <div className="divide-y divide-border rounded-2xl border border-border bg-card px-5">
          <div className="flex items-center justify-between gap-6 py-4">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">显示预测消息</p>
              <p className="text-sm leading-relaxed text-muted-foreground">
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
          </div>
          <div className="flex items-center justify-between gap-6 py-4">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">显示上下文窗口使用情况</p>
              <p className="text-sm leading-relaxed text-muted-foreground">在输入框中显示当前会话的上下文用量。</p>
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
          </div>
        </div>
      </section>
      <section className="space-y-3">
        <h3 className="text-sm font-medium">权限</h3>
        <div className="rounded-2xl border border-border bg-card px-5">{accessSettings}</div>
      </section>
      <StorageSettings {...storage} />
    </div>
  )
}
