import type { ReactNode } from 'react'

export function PersonalizationSettings({ accessSettings }: { accessSettings: ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-medium">访问权限</h3>
      <div className="rounded-2xl border border-border bg-card p-5">{accessSettings}</div>
    </section>
  )
}
