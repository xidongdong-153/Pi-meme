import type { ReactNode } from 'react'

export function GeneralSettings({ accessSettings }: { accessSettings: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">权限</h3>
      <div className="rounded-2xl border border-border bg-card px-5">{accessSettings}</div>
    </section>
  )
}
