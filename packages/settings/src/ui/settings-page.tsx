import type { ReactNode } from 'react'
import type {
  DesktopSettings,
  SettingsSnapshot,
  AppearanceSettings,
  InstalledFont,
  Theme,
} from '@pi-meme/contracts/settings'
import type { SettingsBridge, ModelsBridge } from '@pi-meme/contracts/desktop'
import { ThemeSettings } from './theme-settings'
import { GeneralSettings } from './general-settings'
import { InstructionSettings } from './instruction-settings'
import {
  BentoSkeletonBar,
  BentoSkeletonButton,
  BentoSkeletonCard,
  BentoSkeletonCircle,
} from '@pi-meme/ui/components/bento-skeleton'

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
  onEditor: (value: Pick<DesktopSettings, 'showComposerHint' | 'showContextUsage'>) => void
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
        <div className="space-y-6" data-testid="appearance-skeleton">
          <div className="flex justify-end gap-2">
            <BentoSkeletonButton className="h-8 w-8 rounded-lg" />
            <BentoSkeletonButton className="h-8 w-8 rounded-lg" />
            <BentoSkeletonButton className="h-8 w-8 rounded-lg" />
          </div>
          <section className="space-y-3">
            <BentoSkeletonBar className="w-16" size="sm" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <BentoSkeletonCard delay={0} className="flex h-28 flex-col justify-between p-4">
                <div className="h-10 w-full rounded-lg bg-muted/40" />
                <BentoSkeletonBar className="w-16" size="xs" />
              </BentoSkeletonCard>
              <BentoSkeletonCard delay={80} className="flex h-28 flex-col justify-between p-4">
                <div className="h-10 w-full rounded-lg bg-muted/40" />
                <BentoSkeletonBar className="w-16" size="xs" />
              </BentoSkeletonCard>
              <BentoSkeletonCard delay={160} className="flex h-28 flex-col justify-between p-4">
                <div className="h-10 w-full rounded-lg bg-muted/40" />
                <BentoSkeletonBar className="w-16" size="xs" />
              </BentoSkeletonCard>
            </div>
          </section>
          <section className="space-y-3">
            <BentoSkeletonBar className="w-16" size="sm" />
            <BentoSkeletonCard delay={120}>
              <div className="flex flex-wrap items-center gap-3">
                {Array.from({ length: 8 }).map((_, index) => (
                  <BentoSkeletonCircle key={index} className="size-8" />
                ))}
              </div>
            </BentoSkeletonCard>
          </section>
        </div>
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
