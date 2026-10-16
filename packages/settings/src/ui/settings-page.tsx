import type { ReactNode } from 'react'
import type { SettingsSnapshot, AppearanceSettings, InstalledFont, Theme } from '@pi-meme/contracts/settings'
import type { SettingsBridge, ModelsBridge } from '@pi-meme/contracts/desktop'
import { ThemeSettings } from './theme-settings'
import { GeneralSettings } from './general-settings'
import { InstructionSettings } from './instruction-settings'

export type SettingsPageProps = {
  section: 'about' | 'appearance' | 'general' | 'instructions'
  snapshot: SettingsSnapshot | null
  piVersion?: string
  error: string
  bridge: Pick<SettingsBridge, 'getInstructions' | 'saveInstruction' | 'getStorageInfo' | 'storage'> &
    Pick<ModelsBridge, 'reconnectModels'>
  onBeforeRestart: () => Promise<void>
  cwd: string
  busy: boolean
  onDirty: (dirty: boolean) => void
  onSaving: (saving: boolean) => void
  accessSettings: ReactNode
  onAppearance: (value: AppearanceSettings) => void
  onPreview: (mode: 'light' | 'dark' | null) => void
  onFlush: () => Promise<void>
  loadFonts: () => Promise<InstalledFont[]>
  onImport: () => void
  onExport: (theme: Theme) => void
  onReload: () => void
  onOpenDirectory: () => void
}

export function SettingsPage({
  section,
  snapshot,
  piVersion,
  error,
  bridge,
  cwd,
  busy,
  onDirty,
  onSaving,
  accessSettings,
  onBeforeRestart,
  ...appearance
}: SettingsPageProps) {
  return (
    <div className="space-y-6">
      {section === 'instructions' ? (
        <InstructionSettings bridge={bridge} cwd={cwd} busy={busy} onDirty={onDirty} onSaving={onSaving} />
      ) : section === 'general' ? (
        <GeneralSettings
          accessSettings={accessSettings}
          bridge={bridge}
          onBeforeRestart={onBeforeRestart}
          onMaintaining={onSaving}
        />
      ) : section === 'about' ? (
        <div className="space-y-4 rounded-2xl border border-border bg-card p-6">
          <h3 className="text-sm font-medium">Pi 运行时</h3>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <dt className="text-muted-foreground">内置版本</dt>
            <dd>{piVersion ? `v${piVersion}` : '尚未连接'}</dd>
          </dl>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Pi 运行时随 Host 一起分发，不需要另外安装 Pi CLI；升级随 Host 或应用版本发布。
          </p>
        </div>
      ) : snapshot ? (
        <ThemeSettings snapshot={snapshot} {...appearance} />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          正在加载设置…
        </p>
      )}
      {snapshot?.errors.map((message) => (
        <p key={message} role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {message}
        </p>
      ))}
      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
