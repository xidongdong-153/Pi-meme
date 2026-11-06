import type { ReactNode } from 'react'
import type {
  DesktopSettings,
  SettingsSnapshot,
  AppearanceOperation,
  InstalledFont,
  Theme,
} from '@pi-meme/contracts/settings'
import type { SettingsBridge, ModelsBridge } from '@pi-meme/contracts/desktop'
import { ThemeSettings } from './theme-settings'
import type { AppearanceSaveStatus } from './appearance-save'
import { GeneralSettings } from './general-settings'
import { InstructionSettings } from './instruction-settings'
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { Button } from '@pi-meme/ui/components/ui/button'
import { SettingsCard, SettingsGroup, settingsControlClassName } from '@pi-meme/ui/components/settings'

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
  onMaintaining: (maintaining: boolean) => void
  accessSettings: ReactNode
  onEditor: (value: Pick<DesktopSettings, 'showComposerHint' | 'showContextUsage' | 'contextWindowArchive'>) => void
  onOperation: (operation: AppearanceOperation) => void
  status?: AppearanceSaveStatus
  frozen?: boolean
  onRetry?: () => void
  onAdoptLatest?: () => void
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
  onMaintaining,
  accessSettings,
  onEditor,
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
          settings={snapshot?.settings}
          onEditor={onEditor}
          bridge={bridge}
          onBeforeRestart={onBeforeRestart}
          onMaintaining={onMaintaining}
        />
      ) : section === 'about' ? (
        <SettingsGroup title="Pi">
          <SettingsCard>
            <dl className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs">
              <dt className="font-medium">内置版本</dt>
              <dd>
                <CrossfadeText>{piVersion ? `v${piVersion}` : '尚未连接'}</CrossfadeText>
              </dd>
            </dl>
          </SettingsCard>
        </SettingsGroup>
      ) : (
        <ThemeSettings snapshot={snapshot} {...appearance} />
      )}
      {snapshot?.errors.map((message) => (
        <p key={message} role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
          {message}
        </p>
      ))}
      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
          {error}
          <Button
            variant="outline"
            size="sm"
            className={`ml-3 ${settingsControlClassName}`}
            onClick={appearance.onReload}
          >
            重新读取
          </Button>
        </p>
      )}
    </div>
  )
}
