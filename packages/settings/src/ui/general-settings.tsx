import type { ComponentProps, ReactNode } from 'react'
import { StorageSettings } from './storage-settings'

export function GeneralSettings({
  accessSettings,
  ...storage
}: { accessSettings: ReactNode } & ComponentProps<typeof StorageSettings>) {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-medium">权限</h3>
        <div className="rounded-2xl border border-border bg-card px-5">{accessSettings}</div>
      </section>
      <StorageSettings {...storage} />
    </div>
  )
}
