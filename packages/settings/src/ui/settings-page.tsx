import type { ReactNode } from 'react'
import type {
  GeneralSessionSettings,
  SettingsSnapshot,
  AppearanceOperation,
  InstalledFont,
  Theme,
} from '@pi-meme/contracts/settings'
import type { SettingsBridge, ModelsBridge } from '@pi-meme/contracts/desktop'
import { AppUpdateSettings } from './app-update-settings'
import { ThemeSettings } from './theme-settings'
import type { AppearanceSaveStatus } from './appearance-save'
import { GeneralSettings } from './general-settings'
import { InstructionSettings } from './instruction-settings'
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { Button } from '@pi-meme/ui/components/ui/button'
import { SettingsCard, SettingsGroup, settingsControlClassName } from '@pi-meme/ui/components/settings'

export type SettingsPageProps = {
  mobile?: boolean
  section: 'about' | 'appearance' | 'general' | 'instructions'
  snapshot: SettingsSnapshot | null
  piVersion?: string
  desktopUpdates?: SettingsBridge['desktopUpdates']
  hostId?: string
  hostLabel: string
  hostLocal: boolean
  hostConnected: boolean
  error: string
  bridge: Pick<SettingsBridge, 'getInstructions' | 'saveInstruction' | 'getStorageInfo' | 'storage' | 'appUpdates'> &
    Pick<ModelsBridge, 'reconnectModels'>
  onBeforeRestart: () => Promise<void>
  cwd: string
  busy: boolean
  onDirty: (dirty: boolean) => void
  onSaving: (saving: boolean) => void
  onMaintaining: (maintaining: boolean) => void
  accessSettings: ReactNode
  onEditor: (value: GeneralSessionSettings) => void
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
  mobile = false,
  section,
  snapshot,
  piVersion,
  desktopUpdates,
  hostId,
  hostLabel,
  hostLocal,
  hostConnected,
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
        <InstructionSettings
          mobile={mobile}
          bridge={bridge}
          cwd={cwd}
          busy={busy}
          onDirty={onDirty}
          onSaving={onSaving}
        />
      ) : section === 'general' ? (
        <GeneralSettings
          mobile={mobile}
          accessSettings={accessSettings}
          settings={snapshot?.settings}
          onEditor={onEditor}
          bridge={bridge}
          onBeforeRestart={onBeforeRestart}
          onMaintaining={onMaintaining}
        />
      ) : section === 'about' ? (
        <>
          <AppUpdateSettings
            key={hostId}
            desktop={desktopUpdates}
            host={bridge.appUpdates}
            hostId={hostId}
            hostLabel={hostLabel}
            hostLocal={hostLocal}
            connected={hostConnected}
          />
          <SettingsGroup title="Pi 运行时">
            <SettingsCard>
              <dl className="settings-row flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs sm:px-5">
                <dt className="font-medium">内置版本</dt>
                <dd className="font-mono text-muted-foreground select-text">
                  <CrossfadeText>{hostConnected && piVersion ? `v${piVersion}` : '尚未连接'}</CrossfadeText>
                </dd>
              </dl>
            </SettingsCard>
          </SettingsGroup>
        </>
      ) : (
        <ThemeSettings mobile={mobile} snapshot={snapshot} {...appearance} />
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
